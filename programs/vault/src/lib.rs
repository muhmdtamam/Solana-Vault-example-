//! SOL vault example for Anchor.
//!
//! Each user gets one vault: a PDA owned by this program. Only the owner can
//! deposit into it or withdraw from it.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

// Rewritten by `anchor keys sync` to match target/deploy/vault-keypair.json.
declare_id!("HK2eVkYAjbLUTW2RK5Q1Trht2qN9fidNxcgXaFi5V2aA");

/// Seed prefix. Vault address = PDA(["vault", owner], program_id).
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod vault {
    use super::*;

    /// Creates the vault PDA for the signer.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        vault.owner = ctx.accounts.owner.key();
        // Store the canonical bump so later calls can skip the bump search.
        vault.bump = ctx.bumps.vault;

        msg!("Vault {} initialized for owner {}", vault.key(), vault.owner);
        Ok(())
    }

    /// Moves `amount` lamports from the owner's wallet into the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        // CPI: call the System Program's transfer. The owner's signature on
        // this transaction authorizes it. Any account can receive lamports,
        // even one owned by another program.
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        msg!("Deposited {} lamports into {}", amount, ctx.accounts.vault.key());
        Ok(())
    }

    /// Moves `amount` lamports from the vault back to the owner.
    /// The `Withdraw` constraints already verified that the signer is the owner.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        // AccountInfo is the raw account view: address, lamports, data, owner.
        let vault_info = ctx.accounts.vault.to_account_info();
        let owner_info = ctx.accounts.owner.to_account_info();

        // Keep the rent-exempt minimum in the vault; only the rest is withdrawable.
        let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
        let vault_balance = vault_info.lamports();
        let withdrawable = vault_balance.saturating_sub(rent_floor);
        require!(amount <= withdrawable, VaultError::InsufficientFunds);

        let new_vault_balance = vault_balance
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;
        let new_owner_balance = owner_info
            .lamports()
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        // No CPI here: the System Program only debits accounts it owns, and
        // this program owns the vault. A program may debit its own accounts
        // directly; the runtime checks that total lamports stay balanced.
        **vault_info.try_borrow_mut_lamports()? = new_vault_balance;
        **owner_info.try_borrow_mut_lamports()? = new_owner_balance;

        msg!("Withdrew {} lamports from {}", amount, ctx.accounts.vault.key());
        Ok(())
    }
}

/// Data stored in the vault PDA. The SOL balance is the account's lamports,
/// not a field.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Only wallet allowed to deposit and withdraw.
    pub owner: Pubkey,
    /// Canonical PDA bump.
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Future owner. Signs and pays rent, so it must be writable.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        // 8-byte discriminator + Vault fields.
        space = Vault::DISCRIMINATOR.len() + Vault::INIT_SPACE,
        // The owner's key is a seed, so nobody can create a vault at
        // someone else's address.
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Source of the funds.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        // Re-derive the PDA from the stored owner and bump to prove this
        // is a real vault.
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
        // Signer must match vault.owner.
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Receives the funds.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
        // Authorization check: only the stored owner may withdraw.
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
}

/// Custom errors, numbered from 6000.
#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can perform this action")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Amount exceeds the withdrawable balance (the rent-exempt reserve cannot be withdrawn)")]
    InsufficientFunds,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
