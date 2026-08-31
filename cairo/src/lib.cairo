use starknet::ContractAddress;

// Must match privacy::objects::OpenNoteDeposit (positional Serde).
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

#[starknet::interface]
pub trait IErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
}

// ─── Auction types ──────────────────────────────────────────────────────────

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum AuctionType {
    FirstPrice,
    Vickrey,
}

// ─── Read structs ───────────────────────────────────────────────────────────

#[derive(Serde, Copy, Drop, Debug)]
pub struct AuctionInfo {
    pub id: u64,
    pub seller: ContractAddress,
    pub item_name: felt252,
    pub token: ContractAddress,
    pub auction_type: AuctionType,
    pub bidding_end: u64,
    pub reveal_end: u64,
    pub min_bid: u128,
    pub settled: bool,
    pub cancelled: bool,
    pub winner: ContractAddress,
    pub winning_amount: u128,
    pub bid_count: u32,
}

#[derive(Serde, Copy, Drop, Debug)]
pub struct BidInfo {
    pub bidder: ContractAddress,
    pub auction_id: u64,
    pub revealed: bool,
    pub amount: u128,
    pub deposit: u128,
}

// ─── Helpers ──────────────────────────────────────────────────────────────

pub fn compute_commitment(amount: u128, salt: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(array![amount.into(), salt].span())
}

fn is_zero_address(addr: ContractAddress) -> bool {
    let felt: felt252 = addr.into();
    felt == 0
}

// ─── Contract interface ────────────────────────────────────────────────────

#[starknet::interface]
pub trait IShade<TState> {
    // Auction lifecycle
    fn create_auction(
        ref self: TState,
        item_name: felt252,
        token: ContractAddress,
        auction_type: AuctionType,
        bidding_duration: u64,
        reveal_duration: u64,
        min_bid: u128,
    ) -> u64;
    fn cancel_auction(ref self: TState, auction_id: u64);

    // Bidding (via privacy_invoke — pool sends funds first)
    fn privacy_invoke(
        ref self: TState,
        token: ContractAddress,
        pool_address: ContractAddress,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;

    // Direct bid with deposit (non-pool path for testing)
    fn place_bid(
        ref self: TState,
        auction_id: u64,
        commitment: felt252,
        deposit_amount: u128,
    );

    // Reveal phase
    fn reveal_bid(ref self: TState, auction_id: u64, amount: u128, salt: felt252);

    // Settlement
    fn settle(ref self: TState, auction_id: u64);
    fn claim_refund(ref self: TState, auction_id: u64);

    // Read functions
    fn get_auction(self: @TState, auction_id: u64) -> AuctionInfo;
    fn get_bid(self: @TState, auction_id: u64, bidder: ContractAddress) -> BidInfo;
    fn get_auction_count(self: @TState) -> u64;
}

#[starknet::contract]
mod Shade {
    use starknet::storage::{
        Map, StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry,
    };
    use starknet::{
        ContractAddress, get_caller_address, get_contract_address, get_block_timestamp,
    };
    use super::{
        IErc20Dispatcher, IErc20DispatcherTrait, OpenNoteDeposit, AuctionType, AuctionInfo,
        BidInfo, compute_commitment, is_zero_address,
    };

    // ─── Errors ──────────────────────────────────────────────────────────

    mod errors {
        pub const BAD_POOL: felt252 = 'BAD_POOL';
        pub const NO_INPUT: felt252 = 'NO_INPUT';
        pub const OVERFLOW: felt252 = 'OVERFLOW';
        pub const NOT_FOUND: felt252 = 'AUCTION_NOT_FOUND';
        pub const BIDDING_CLOSED: felt252 = 'BIDDING_CLOSED';
        pub const REVEAL_NOT_OPEN: felt252 = 'REVEAL_NOT_OPEN';
        pub const REVEAL_CLOSED: felt252 = 'REVEAL_CLOSED';
        pub const ALREADY_BID: felt252 = 'ALREADY_BID';
        pub const BAD_COMMITMENT: felt252 = 'BAD_COMMITMENT';
        pub const ALREADY_REVEALED: felt252 = 'ALREADY_REVEALED';
        pub const BELOW_MIN: felt252 = 'BELOW_MIN_BID';
        pub const NOT_SELLER: felt252 = 'NOT_SELLER';
        pub const NOT_SETTLED: felt252 = 'NOT_SETTLED';
        pub const ALREADY_SETTLED: felt252 = 'ALREADY_SETTLED';
        pub const AUCTION_ACTIVE: felt252 = 'AUCTION_STILL_ACTIVE';
        pub const NO_BIDS: felt252 = 'NO_BIDS';
        pub const NOT_WINNER: felt252 = 'NOT_WINNER';
        pub const IS_WINNER: felt252 = 'WINNER_CANT_REFUND';
        pub const NO_DEPOSIT: felt252 = 'NO_DEPOSIT';
        pub const CANCELLED: felt252 = 'AUCTION_CANCELLED';
        pub const NOT_CANCELLED: felt252 = 'NOT_CANCELLED';
        pub const BIDDING_OPEN: felt252 = 'BIDDING_STILL_OPEN';
        pub const DEPOSIT_TOO_LOW: felt252 = 'DEPOSIT_TOO_LOW';
    }

    // ─── Storage ─────────────────────────────────────────────────────────

    #[storage]
    struct Storage {
        auction_count: u64,
        // Auction data
        seller: Map<u64, ContractAddress>,
        item_name: Map<u64, felt252>,
        token: Map<u64, ContractAddress>,
        auction_type: Map<u64, u8>, // 0 = FirstPrice, 1 = Vickrey
        bidding_end: Map<u64, u64>,
        reveal_end: Map<u64, u64>,
        min_bid: Map<u64, u128>,
        settled: Map<u64, bool>,
        cancelled: Map<u64, bool>,
        // Winner tracking
        winner: Map<u64, ContractAddress>,
        highest_bid: Map<u64, u128>,
        second_highest: Map<u64, u128>,
        bid_count: Map<u64, u32>,
        // Bid data: (auction_id, bidder) → bid info
        commitment: Map<(u64, ContractAddress), felt252>,
        deposit: Map<(u64, ContractAddress), u128>,
        revealed: Map<(u64, ContractAddress), bool>,
        bid_amount: Map<(u64, ContractAddress), u128>,
        refunded: Map<(u64, ContractAddress), bool>,
        // Pool integration
        pool_bid_note: Map<(u64, felt252), ContractAddress>, // (auction_id, note_id) → bidder
        pool_bid_deposit: Map<(u64, felt252), u128>, // (auction_id, note_id) → deposit amount
    }

    // ─── Events ──────────────────────────────────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        AuctionCreated: AuctionCreated,
        BidPlaced: BidPlaced,
        BidRevealed: BidRevealed,
        AuctionSettled: AuctionSettled,
        RefundClaimed: RefundClaimed,
        AuctionCancelled: AuctionCancelled,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionCreated {
        #[key]
        auction_id: u64,
        #[key]
        seller: ContractAddress,
        item_name: felt252,
        token: ContractAddress,
        bidding_end: u64,
        reveal_end: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct BidPlaced {
        #[key]
        auction_id: u64,
        #[key]
        bidder: ContractAddress,
        commitment: felt252,
        deposit: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct BidRevealed {
        #[key]
        auction_id: u64,
        #[key]
        bidder: ContractAddress,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionSettled {
        #[key]
        auction_id: u64,
        #[key]
        winner: ContractAddress,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct RefundClaimed {
        #[key]
        auction_id: u64,
        #[key]
        bidder: ContractAddress,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionCancelled {
        #[key]
        auction_id: u64,
        #[key]
        seller: ContractAddress,
    }

    // ─── Implementation ──────────────────────────────────────────────────

    #[abi(embed_v0)]
    impl ShadeImpl of super::IShade<ContractState> {

        // ── Auction lifecycle ────────────────────────────────────────────

        fn create_auction(
            ref self: ContractState,
            item_name: felt252,
            token: ContractAddress,
            auction_type: AuctionType,
            bidding_duration: u64,
            reveal_duration: u64,
            min_bid: u128,
        ) -> u64 {
            let now = get_block_timestamp();
            let id = self.auction_count.read() + 1;
            let seller = get_caller_address();

            self.auction_count.write(id);
            self.seller.entry(id).write(seller);
            self.item_name.entry(id).write(item_name);
            self.token.entry(id).write(token);
            let at: u8 = match auction_type {
                AuctionType::FirstPrice => 0,
                AuctionType::Vickrey => 1,
            };
            self.auction_type.entry(id).write(at);
            self.bidding_end.entry(id).write(now + bidding_duration);
            self.reveal_end.entry(id).write(now + bidding_duration + reveal_duration);
            self.min_bid.entry(id).write(min_bid);
            self.settled.entry(id).write(false);
            self.cancelled.entry(id).write(false);
            self.bid_count.entry(id).write(0);
            self.highest_bid.entry(id).write(0);
            self.second_highest.entry(id).write(0);

            self.emit(AuctionCreated {
                auction_id: id,
                seller,
                item_name,
                token,
                bidding_end: now + bidding_duration,
                reveal_end: now + bidding_duration + reveal_duration,
            });

            id
        }

        fn cancel_auction(ref self: ContractState, auction_id: u64) {
            let seller = self.seller.entry(auction_id).read();
            assert(get_caller_address() == seller, errors::NOT_SELLER);
            assert(!self.settled.entry(auction_id).read(), errors::ALREADY_SETTLED);
            let now = get_block_timestamp();
            assert(now < self.bidding_end.entry(auction_id).read(), errors::BIDDING_CLOSED);

            self.cancelled.entry(auction_id).write(true);
            self.emit(AuctionCancelled { auction_id, seller });
        }

        // ── Bidding via privacy_invoke (pool path) ──────────────────────

        fn privacy_invoke(
            ref self: ContractState,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let caller = get_caller_address();
            assert(pool_address == caller, errors::BAD_POOL);

            let erc20 = IErc20Dispatcher { contract_address: token };
            let balance: u256 = erc20.balance_of(get_contract_address());
            let amount: u128 = balance.try_into().expect(errors::OVERFLOW);
            assert(amount != 0, errors::NO_INPUT);

            // Find the auction that's currently in bidding phase
            let auction_count = self.auction_count.read();
            let mut active_auction: u64 = 0;
            let mut i: u64 = 1;
            let now = get_block_timestamp();
            loop {
                if i > auction_count {
                    break;
                }
                if !self.settled.entry(i).read()
                    && !self.cancelled.entry(i).read()
                    && now < self.bidding_end.entry(i).read()
                    && self.token.entry(i).read() == token
                {
                    active_auction = i;
                    break;
                }
                i += 1;
            };
            assert(active_auction != 0, errors::BIDDING_CLOSED);

            // Record the pool-based bid
            self.pool_bid_note.entry((active_auction, note_id)).write(pool_address);
            self.pool_bid_deposit.entry((active_auction, note_id)).write(amount);

            // Approve pool to pull funds back (fills open note)
            erc20.approve(pool_address, balance);

            array![OpenNoteDeposit { note_id, token, amount }].span()
        }

        // ── Direct bid with ERC20 deposit ───────────────────────────────

        fn place_bid(
            ref self: ContractState,
            auction_id: u64,
            commitment: felt252,
            deposit_amount: u128,
        ) {
            let now = get_block_timestamp();
            let bidding_end = self.bidding_end.entry(auction_id).read();
            assert(bidding_end != 0, errors::NOT_FOUND);
            assert(!self.cancelled.entry(auction_id).read(), errors::CANCELLED);
            assert(now < bidding_end, errors::BIDDING_CLOSED);

            let bidder = get_caller_address();
            let existing = self.commitment.entry((auction_id, bidder)).read();
            assert(existing == 0, errors::ALREADY_BID);

            assert(deposit_amount >= self.min_bid.entry(auction_id).read(), errors::DEPOSIT_TOO_LOW);

            // Transfer deposit from bidder to this contract
            let token = self.token.entry(auction_id).read();
            let erc20 = IErc20Dispatcher { contract_address: token };
            erc20.transfer_from(bidder, get_contract_address(), deposit_amount.into());

            // Store commitment and deposit
            self.commitment.entry((auction_id, bidder)).write(commitment);
            self.deposit.entry((auction_id, bidder)).write(deposit_amount);
            self.bid_count.entry(auction_id).write(self.bid_count.entry(auction_id).read() + 1);

            self.emit(BidPlaced { auction_id, bidder, commitment, deposit: deposit_amount });
        }

        // ── Reveal phase ────────────────────────────────────────────────

        fn reveal_bid(ref self: ContractState, auction_id: u64, amount: u128, salt: felt252) {
            let now = get_block_timestamp();
            let bidding_end = self.bidding_end.entry(auction_id).read();
            let reveal_end = self.reveal_end.entry(auction_id).read();
            assert(bidding_end != 0, errors::NOT_FOUND);
            assert(!self.cancelled.entry(auction_id).read(), errors::CANCELLED);
            assert(now >= bidding_end, errors::REVEAL_NOT_OPEN);
            assert(now < reveal_end, errors::REVEAL_CLOSED);

            let bidder = get_caller_address();
            let stored_commitment = self.commitment.entry((auction_id, bidder)).read();
            assert(stored_commitment != 0, errors::NOT_FOUND);
            assert(!self.revealed.entry((auction_id, bidder)).read(), errors::ALREADY_REVEALED);

            // Verify commitment: poseidon(amount, salt) must match
            let expected = compute_commitment(amount, salt);
            assert(expected == stored_commitment, errors::BAD_COMMITMENT);

            // Verify amount doesn't exceed deposit
            let dep = self.deposit.entry((auction_id, bidder)).read();
            assert(amount <= dep, errors::OVERFLOW);

            // Check minimum bid
            assert(amount >= self.min_bid.entry(auction_id).read(), errors::BELOW_MIN);

            // Mark as revealed
            self.revealed.entry((auction_id, bidder)).write(true);
            self.bid_amount.entry((auction_id, bidder)).write(amount);

            // Update highest / second highest
            let current_highest = self.highest_bid.entry(auction_id).read();
            if amount > current_highest {
                // Current highest becomes second highest
                self.second_highest.entry(auction_id).write(current_highest);
                self.highest_bid.entry(auction_id).write(amount);
                self.winner.entry(auction_id).write(bidder);
            } else if amount > self.second_highest.entry(auction_id).read() {
                self.second_highest.entry(auction_id).write(amount);
            }

            self.emit(BidRevealed { auction_id, bidder, amount });
        }

        // ── Settlement ──────────────────────────────────────────────────

        fn settle(ref self: ContractState, auction_id: u64) {
            let now = get_block_timestamp();
            let reveal_end = self.reveal_end.entry(auction_id).read();
            assert(reveal_end != 0, errors::NOT_FOUND);
            assert(!self.cancelled.entry(auction_id).read(), errors::CANCELLED);
            assert(!self.settled.entry(auction_id).read(), errors::ALREADY_SETTLED);
            assert(now >= reveal_end, errors::AUCTION_ACTIVE);

            let bid_count = self.bid_count.entry(auction_id).read();
            assert(bid_count > 0, errors::NO_BIDS);

            let winner = self.winner.entry(auction_id).read();
            assert(!is_zero_address(winner), errors::NO_BIDS);

            // Determine settlement price
            let at_raw = self.auction_type.entry(auction_id).read();
            let price = if at_raw == 1 {
                // Vickrey: winner pays second-highest bid
                self.second_highest.entry(auction_id).read()
            } else {
                // First price: winner pays their bid
                self.highest_bid.entry(auction_id).read()
            };

            // Transfer payment to seller
            let token = self.token.entry(auction_id).read();
            let seller = self.seller.entry(auction_id).read();
            let erc20 = IErc20Dispatcher { contract_address: token };

            if price > 0 {
                erc20.transfer(seller, price.into());
            }

            self.settled.entry(auction_id).write(true);

            let winning_amount = self.highest_bid.entry(auction_id).read();
            self.emit(AuctionSettled { auction_id, winner, amount: winning_amount });
        }

        fn claim_refund(ref self: ContractState, auction_id: u64) {
            assert(self.settled.entry(auction_id).read(), errors::NOT_SETTLED);
            assert(!self.cancelled.entry(auction_id).read(), errors::CANCELLED);

            let bidder = get_caller_address();
            let dep = self.deposit.entry((auction_id, bidder)).read();
            assert(dep > 0, errors::NO_DEPOSIT);
            assert(!self.refunded.entry((auction_id, bidder)).read(), errors::NO_DEPOSIT);

            let winner = self.winner.entry(auction_id).read();
            assert(bidder != winner, errors::IS_WINNER);

            self.refunded.entry((auction_id, bidder)).write(true);

            let token = self.token.entry(auction_id).read();
            let erc20 = IErc20Dispatcher { contract_address: token };
            erc20.transfer(bidder, dep.into());

            self.emit(RefundClaimed { auction_id, bidder, amount: dep });
        }

        // ── Read functions ──────────────────────────────────────────────

        fn get_auction(self: @ContractState, auction_id: u64) -> AuctionInfo {
            let bidding_end = self.bidding_end.entry(auction_id).read();
            assert(bidding_end != 0, errors::NOT_FOUND);

            let at_raw = self.auction_type.entry(auction_id).read();
            let auction_type = if at_raw == 0 {
                AuctionType::FirstPrice
            } else {
                AuctionType::Vickrey
            };

            AuctionInfo {
                id: auction_id,
                seller: self.seller.entry(auction_id).read(),
                item_name: self.item_name.entry(auction_id).read(),
                token: self.token.entry(auction_id).read(),
                auction_type,
                bidding_end,
                reveal_end: self.reveal_end.entry(auction_id).read(),
                min_bid: self.min_bid.entry(auction_id).read(),
                settled: self.settled.entry(auction_id).read(),
                cancelled: self.cancelled.entry(auction_id).read(),
                winner: self.winner.entry(auction_id).read(),
                winning_amount: self.highest_bid.entry(auction_id).read(),
                bid_count: self.bid_count.entry(auction_id).read(),
            }
        }

        fn get_bid(self: @ContractState, auction_id: u64, bidder: ContractAddress) -> BidInfo {
            BidInfo {
                bidder,
                auction_id,
                revealed: self.revealed.entry((auction_id, bidder)).read(),
                amount: self.bid_amount.entry((auction_id, bidder)).read(),
                deposit: self.deposit.entry((auction_id, bidder)).read(),
            }
        }

        fn get_auction_count(self: @ContractState) -> u64 {
            self.auction_count.read()
        }
    }
}
