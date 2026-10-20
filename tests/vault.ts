import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Vault } from "../target/types/vault";

const { Keypair, LAMPORTS_PER_SOL, PublicKey } = anchor.web3;

describe("vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vault as Program<Vault>;
  const connection = provider.connection;

  // The provider wallet pays fees, so balance changes of `owner` equal the
  // amounts moved.
  const owner = Keypair.generate();
  const attacker = Keypair.generate();

  // Same derivation as the program: ["vault", owner]
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId
  );

  const DEPOSIT_AMOUNT = 1 * LAMPORTS_PER_SOL;
  const WITHDRAW_AMOUNT = 0.4 * LAMPORTS_PER_SOL;

  async function airdrop(address: anchor.web3.PublicKey, sol: number) {
    const signature = await connection.requestAirdrop(
      address,
      sol * LAMPORTS_PER_SOL
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature, ...latest },
      "confirmed"
    );
  }

  /** Expects `promise` to reject with the given Anchor error code. */
  async function expectAnchorError(promise: Promise<unknown>, code: string) {
    try {
      await promise;
    } catch (err) {
      expect(err).to.be.instanceOf(anchor.AnchorError);
      expect((err as anchor.AnchorError).error.errorCode.code).to.equal(code);
      return;
    }
    // Outside the try/catch so this failure isn't swallowed.
    expect.fail(`Expected the transaction to fail with ${code}`);
  }

  before(async () => {
    await airdrop(owner.publicKey, 5);
    await airdrop(attacker.publicKey, 1);
  });

  it("initializes a vault PDA bound to the owner", async () => {
    await program.methods
      .initialize()
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
      .signers([owner])
      .rpc();

    const state = await program.account.vault.fetch(vaultPda);
    expect(state.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(state.bump).to.equal(vaultBump);
  });

  it("deposits SOL into the vault", async () => {
    const vaultBefore = await connection.getBalance(vaultPda);
    const ownerBefore = await connection.getBalance(owner.publicKey);

    await program.methods
      .deposit(new anchor.BN(DEPOSIT_AMOUNT))
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
      .signers([owner])
      .rpc();

    const vaultAfter = await connection.getBalance(vaultPda);
    const ownerAfter = await connection.getBalance(owner.publicKey);

    expect(vaultAfter - vaultBefore).to.equal(DEPOSIT_AMOUNT);
    expect(ownerBefore - ownerAfter).to.equal(DEPOSIT_AMOUNT);
  });

  it("lets the owner withdraw SOL", async () => {
    const vaultBefore = await connection.getBalance(vaultPda);
    const ownerBefore = await connection.getBalance(owner.publicKey);

    await program.methods
      .withdraw(new anchor.BN(WITHDRAW_AMOUNT))
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
      .signers([owner])
      .rpc();

    const vaultAfter = await connection.getBalance(vaultPda);
    const ownerAfter = await connection.getBalance(owner.publicKey);

    expect(vaultBefore - vaultAfter).to.equal(WITHDRAW_AMOUNT);
    expect(ownerAfter - ownerBefore).to.equal(WITHDRAW_AMOUNT);
  });

  it("rejects a withdrawal signed by someone who is not the owner", async () => {
    const vaultBefore = await connection.getBalance(vaultPda);
    const attackerBefore = await connection.getBalance(attacker.publicKey);

    // Real vault PDA, wrong signer: the PDA check passes, has_one fails.
    await expectAnchorError(
      program.methods
        .withdraw(new anchor.BN(0.1 * LAMPORTS_PER_SOL))
        .accountsPartial({ owner: attacker.publicKey, vault: vaultPda })
        .signers([attacker])
        .rpc(),
      "Unauthorized"
    );

    expect(await connection.getBalance(vaultPda)).to.equal(vaultBefore);
    expect(await connection.getBalance(attacker.publicKey)).to.equal(
      attackerBefore
    );
  });

  it("rejects a deposit signed by someone who is not the owner", async () => {
    await expectAnchorError(
      program.methods
        .deposit(new anchor.BN(0.1 * LAMPORTS_PER_SOL))
        .accountsPartial({ owner: attacker.publicKey, vault: vaultPda })
        .signers([attacker])
        .rpc(),
      "Unauthorized"
    );
  });

  it("rejects zero-amount deposits and withdrawals", async () => {
    await expectAnchorError(
      program.methods
        .deposit(new anchor.BN(0))
        .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
        .signers([owner])
        .rpc(),
      "InvalidAmount"
    );

    await expectAnchorError(
      program.methods
        .withdraw(new anchor.BN(0))
        .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
        .signers([owner])
        .rpc(),
      "InvalidAmount"
    );
  });

  it("rejects withdrawing more than the vault holds", async () => {
    const vaultBalance = await connection.getBalance(vaultPda);

    // The full balance would dip into the rent reserve, so it must fail.
    await expectAnchorError(
      program.methods
        .withdraw(new anchor.BN(vaultBalance))
        .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
        .signers([owner])
        .rpc(),
      "InsufficientFunds"
    );
  });

  it("lets the owner withdraw everything above the rent-exempt reserve", async () => {
    const vaultInfo = await connection.getAccountInfo(vaultPda);
    expect(vaultInfo).to.not.equal(null);

    const rentFloor = await connection.getMinimumBalanceForRentExemption(
      vaultInfo!.data.length
    );
    const withdrawable = vaultInfo!.lamports - rentFloor;
    expect(withdrawable).to.be.greaterThan(0);

    await program.methods
      .withdraw(new anchor.BN(withdrawable))
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda })
      .signers([owner])
      .rpc();

    expect(await connection.getBalance(vaultPda)).to.equal(rentFloor);
  });
});
