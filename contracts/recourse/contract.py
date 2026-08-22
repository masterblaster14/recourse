"""
Recourse — a risk layer for x402.

x402 is prepay and one directional: the agent pays, then receives the response.
If the response is stale, the money is gone and there is no recourse. This
contract is the missing half.

Providers register an SLA and stake a bond in the same asset agents pay in. When a provider *signs* a
response that violates its own published SLA, anyone holding that signed
response can prove it on chain and the bond pays the compensation.

IMPORTANT — this contract does NOT reverse the original x402 payment. That
payment settled through the facilitator and is final. Compensation is funded
entirely by the provider's bonded collateral held by this application.

Atomicity applies to the recourse settlement only: refund, slash and counter
update all happen as inner transactions inside a single application call, so
they succeed or fail together.
"""

import typing

from algopy import (
    Account,
    ARC4Contract,
    BoxMap,
    Bytes,
    Global,
    GlobalState,
    OpUpFeeSource,
    Txn,
    UInt64,
    arc4,
    ensure_budget,
    gtxn,
    itxn,
    op,
    subroutine,
)

Bytes32: typing.TypeAlias = arc4.StaticArray[arc4.Byte, typing.Literal[32]]

# A slash is 9x the price of the call on top of the full refund. Cheating on a
# single call therefore costs the provider 10x what it earned from it.
PENALTY_MULTIPLIER = 9


class Provider(arc4.Struct):
    """Per-provider record. Fixed size (121 bytes) so it decodes cheaply off chain."""

    pubkey: Bytes32  # ed25519 key the provider signs responses with
    sla_hash: Bytes32  # sha256 of the published SLA document
    price_micro: arc4.UInt64  # price per call, micro units of the bond asset
    max_staleness: arc4.UInt64  # published SLA bound, seconds
    max_latency_ms: arc4.UInt64  # published SLA bound, milliseconds
    bond_micro: arc4.UInt64  # remaining bond, micro units
    success_count: arc4.UInt64
    claim_count: arc4.UInt64
    slashed_micro: arc4.UInt64  # cumulative refund + penalty paid out
    active: arc4.Bool


class ProviderRegistered(arc4.Struct):
    provider: arc4.Address
    price_micro: arc4.UInt64
    max_staleness: arc4.UInt64
    sla_hash: Bytes32


class BondDeposited(arc4.Struct):
    provider: arc4.Address
    amount_micro: arc4.UInt64
    bond_micro: arc4.UInt64


class ClaimUpheld(arc4.Struct):
    provider: arc4.Address
    payer: arc4.Address
    request_id: Bytes32
    age_seconds: arc4.UInt64
    refund_micro: arc4.UInt64
    penalty_micro: arc4.UInt64
    bond_remaining: arc4.UInt64


class Recourse(ARC4Contract):
    def __init__(self) -> None:
        self.asset_id = GlobalState(UInt64(0), key="asset_id")
        self.treasury = GlobalState(Account(), key="treasury")
        self.provider_count = GlobalState(UInt64(0), key="providers")
        self.claim_count = GlobalState(UInt64(0), key="claims")
        self.total_bonded = GlobalState(UInt64(0), key="bonded")
        self.total_slashed = GlobalState(UInt64(0), key="slashed")

        # provider address -> Provider
        self.providers = BoxMap(Account, Provider, key_prefix=b"p_")
        # request_id (32 bytes) -> timestamp of the upheld claim. Replay guard.
        self.claims = BoxMap(Bytes, UInt64, key_prefix=b"c_")

    # ------------------------------------------------------------------ setup

    @arc4.abimethod(create="require")
    def create(self, asset_id: UInt64) -> None:
        self.asset_id.value = asset_id
        self.treasury.value = Txn.sender

    @arc4.abimethod
    def opt_in_asset(self) -> None:
        """The application account must opt into the bond asset before it can custody bonds."""
        assert Txn.sender == Global.creator_address, "creator only"
        itxn.AssetTransfer(
            xfer_asset=self.asset_id.value,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()

    @arc4.abimethod
    def set_treasury(self, treasury: Account) -> None:
        assert Txn.sender == Global.creator_address, "creator only"
        self.treasury.value = treasury

    # --------------------------------------------------------------- provider

    @arc4.abimethod
    def register(
        self,
        pubkey: Bytes32,
        sla_hash: Bytes32,
        price_micro: UInt64,
        max_staleness: UInt64,
        max_latency_ms: UInt64,
    ) -> None:
        """
        Publish an SLA. `max_staleness` and `max_latency_ms` are the bounds the
        provider will later be judged against, committed by the provider itself.
        """
        assert price_micro > 0, "price must be positive"
        assert max_staleness > 0, "staleness bound must be positive"

        if Txn.sender not in self.providers:
            self.provider_count.value += 1
            self.providers[Txn.sender] = Provider(
                pubkey=pubkey.copy(),
                sla_hash=sla_hash.copy(),
                price_micro=arc4.UInt64(price_micro),
                max_staleness=arc4.UInt64(max_staleness),
                max_latency_ms=arc4.UInt64(max_latency_ms),
                bond_micro=arc4.UInt64(0),
                success_count=arc4.UInt64(0),
                claim_count=arc4.UInt64(0),
                slashed_micro=arc4.UInt64(0),
                active=arc4.Bool(True),  # noqa: FBT003
            )
        else:
            # Re-publishing an SLA keeps the accumulated history and bond.
            p = self.providers[Txn.sender].copy()
            p.pubkey = pubkey.copy()
            p.sla_hash = sla_hash.copy()
            p.price_micro = arc4.UInt64(price_micro)
            p.max_staleness = arc4.UInt64(max_staleness)
            p.max_latency_ms = arc4.UInt64(max_latency_ms)
            self.providers[Txn.sender] = p.copy()

        arc4.emit(
            ProviderRegistered(
                provider=arc4.Address(Txn.sender),
                price_micro=arc4.UInt64(price_micro),
                max_staleness=arc4.UInt64(max_staleness),
                sla_hash=sla_hash.copy(),
            )
        )

    @arc4.abimethod
    def deposit_bond(self, axfer: gtxn.AssetTransferTransaction) -> UInt64:
        """Stake collateral. Grouped with the asset transfer that funds it."""
        assert Txn.sender in self.providers, "not registered"
        assert axfer.asset_receiver == Global.current_application_address, "wrong receiver"
        assert axfer.xfer_asset.id == self.asset_id.value, "wrong asset"
        assert axfer.sender == Txn.sender, "sender mismatch"
        assert axfer.asset_amount > 0, "empty deposit"

        p = self.providers[Txn.sender].copy()
        p.bond_micro = arc4.UInt64(p.bond_micro.native + axfer.asset_amount)
        p.active = arc4.Bool(True)  # noqa: FBT003
        self.providers[Txn.sender] = p.copy()

        self.total_bonded.value += axfer.asset_amount

        arc4.emit(
            BondDeposited(
                provider=arc4.Address(Txn.sender),
                amount_micro=arc4.UInt64(axfer.asset_amount),
                bond_micro=p.bond_micro,
            )
        )
        return p.bond_micro.native

    @arc4.abimethod
    def withdraw_bond(self, amount: UInt64) -> UInt64:
        """A provider may unstake at any time. Unstaking is itself a signal."""
        assert Txn.sender in self.providers, "not registered"
        p = self.providers[Txn.sender].copy()
        assert amount > 0, "nothing to withdraw"
        assert amount <= p.bond_micro.native, "insufficient bond"

        itxn.AssetTransfer(
            xfer_asset=self.asset_id.value,
            asset_receiver=Txn.sender,
            asset_amount=amount,
            fee=0,
        ).submit()

        p.bond_micro = arc4.UInt64(p.bond_micro.native - amount)
        if p.bond_micro.native == 0:
            p.active = arc4.Bool(False)  # noqa: FBT003
        self.providers[Txn.sender] = p.copy()
        self.total_bonded.value -= amount
        return p.bond_micro.native

    # ------------------------------------------------------------------ claim

    @arc4.abimethod
    def submit_claim(
        self,
        provider: Account,
        request_id: Bytes,  # 32 bytes, unique per response
        response_hash: Bytes,  # 32 bytes, sha256 of the canonical payload
        data_timestamp: UInt64,  # the freshness the provider attested to
        signature: Bytes,  # 64 bytes, ed25519 over request_id||hash||ts
    ) -> UInt64:
        """
        Prove that `provider` signed a response violating its own published SLA,
        and settle it atomically: refund the caller, slash the provider, update
        the counters. Returns the micro units refunded.

        The proof is self contained. The contract checks the provider's own
        signature over the response, and compares the timestamp the provider
        attested to against the staleness bound the provider itself published.
        Nobody has to be trusted, and nobody adjudicates.

        Compensation is paid to Txn.sender, who must hold the signed response
        (only obtainable by paying for it) and be opted into the bond asset.
        """
        # ed25519verify_bare alone costs 1900 units against a 700 unit default.
        ensure_budget(2000, OpUpFeeSource.Any)

        assert provider in self.providers, "unknown provider"
        assert request_id.length == 32, "bad request_id"
        assert response_hash.length == 32, "bad response_hash"
        assert signature.length == 64, "bad signature"

        # Replay guard: one response, one claim, ever.
        assert request_id not in self.claims, "already claimed"

        p = self.providers[provider].copy()
        assert p.active.native, "provider inactive"
        assert p.bond_micro.native > 0, "no bond"

        # 1. The provider signed this exact response with this exact timestamp.
        msg = request_id + response_hash + op.itob(data_timestamp)
        assert op.ed25519verify_bare(msg, signature, p.pubkey.bytes), "bad signature"

        # 2. That timestamp violates the staleness bound the provider published.
        assert Global.latest_timestamp > data_timestamp, "timestamp in the future"
        age = Global.latest_timestamp - data_timestamp
        assert age > p.max_staleness.native, "within SLA"

        # 3. Settle out of the bond.
        refund = p.price_micro.native
        penalty = p.price_micro.native * UInt64(PENALTY_MULTIPLIER)
        total = refund + penalty

        if total > p.bond_micro.native:
            # Bond exhausted. Pay out what remains and take the provider offline.
            refund = p.bond_micro.native
            penalty = UInt64(0)
            total = refund
            p.active = arc4.Bool(False)  # noqa: FBT003

        if refund > 0:
            itxn.AssetTransfer(
                xfer_asset=self.asset_id.value,
                asset_receiver=Txn.sender,
                asset_amount=refund,
                fee=0,
            ).submit()

        if penalty > 0:
            itxn.AssetTransfer(
                xfer_asset=self.asset_id.value,
                asset_receiver=self.treasury.value,
                asset_amount=penalty,
                fee=0,
            ).submit()

        p.bond_micro = arc4.UInt64(p.bond_micro.native - total)
        p.claim_count = arc4.UInt64(p.claim_count.native + 1)
        p.slashed_micro = arc4.UInt64(p.slashed_micro.native + total)
        if p.bond_micro.native == 0:
            p.active = arc4.Bool(False)  # noqa: FBT003
        self.providers[provider] = p.copy()

        self.claims[request_id] = Global.latest_timestamp
        self.claim_count.value += 1
        self.total_slashed.value += total
        self.total_bonded.value -= total

        arc4.emit(
            ClaimUpheld(
                provider=arc4.Address(provider),
                payer=arc4.Address(Txn.sender),
                request_id=_to_bytes32(request_id),
                age_seconds=arc4.UInt64(age),
                refund_micro=arc4.UInt64(refund),
                penalty_micro=arc4.UInt64(penalty),
                bond_remaining=p.bond_micro,
            )
        )
        return refund

    @arc4.abimethod
    def record_success(self, provider: Account, count: UInt64) -> UInt64:
        """
        Attest verified good responses. Batched, because the demo makes many
        calls and one transaction per call is pure noise.

        This is the one number in the system that is an attestation rather than
        a proof: the operator is asserting it observed N good responses. It is
        deliberately separate from claim_count, which is proven on chain.
        """
        assert Txn.sender == Global.creator_address, "creator only"
        assert count > 0, "count must be positive"
        p = self.providers[provider].copy()
        p.success_count = arc4.UInt64(p.success_count.native + count)
        self.providers[provider] = p.copy()
        return p.success_count.native

    # ------------------------------------------------------------------ reads

    @arc4.abimethod(readonly=True)
    def read_provider(self, provider: Account) -> Provider:
        return self.providers[provider]

    @arc4.abimethod(readonly=True)
    def is_claimed(self, request_id: Bytes) -> bool:
        return request_id in self.claims

    @arc4.abimethod
    def noop(self) -> None:
        """Budget padding. Grouped with submit_claim to pool opcode budget."""


@subroutine
def _to_bytes32(value: Bytes) -> Bytes32:
    return Bytes32.from_bytes(value)
