import { Taptree } from 'bitcoinjs-lib/src/types.js';
import { TransactionType } from '../enums/TransactionType.js';
import { IUnwrapParameters } from '../interfaces/ITransactionParameters.js';
import { SharedInteractionTransaction } from './SharedInteractionTransaction.js';
import { TransactionBuilder } from './TransactionBuilder.js';
import { ABICoder, BinaryWriter, Selector } from '@btc-vision/bsi-binary';
import { wBTC } from '../../metadata/contracts/wBTC.js';
import { payments, Psbt, Signer, Transaction } from 'bitcoinjs-lib';
import { EcKeyPair } from '../../keypair/EcKeyPair.js';
import { IWBTCUTXODocument, PsbtTransaction, VaultUTXOs } from '../processor/PsbtTransaction.js';
import { PsbtInputExtended, PsbtOutputExtended } from '../interfaces/Tap.js';

const abiCoder: ABICoder = new ABICoder();

/**
 * Unwrap transaction
 * @class UnwrapTransaction
 */
export class UnwrapTransaction extends SharedInteractionTransaction<TransactionType.WBTC_UNWRAP> {
    public static readonly MINIMUM_CONSOLIDATION_AMOUNT: bigint = 200000n;

    private static readonly UNWRAP_SELECTOR: Selector = Number(
        '0x' + abiCoder.encodeSelector('burn'),
    );

    public type: TransactionType.WBTC_UNWRAP = TransactionType.WBTC_UNWRAP;

    /**
     * The amount to wrap
     * @private
     */
    public readonly amount: bigint;

    /**
     * The compiled target script
     * @protected
     */
    protected readonly compiledTargetScript: Buffer;

    /**
     * The script tree
     * @protected
     */
    protected readonly scriptTree: Taptree;

    /**
     * The sighash types for the transaction
     * @protected
     */
    protected sighashTypes: number[] = []; //Transaction.SIGHASH_ALL, Transaction.SIGHASH_ANYONECANPAY

    /**
     * Contract secret for the interaction
     * @protected
     */
    protected readonly contractSecret: Buffer;

    /**
     * The vault UTXOs
     * @protected
     */
    protected readonly vaultUTXOs: VaultUTXOs[];

    /**
     * The wBTC contract
     * @private
     */
    private readonly wbtc: wBTC;

    private readonly calculatedSignHash: number = PsbtTransaction.calculateSignHash(
        this.sighashTypes,
    );

    public constructor(parameters: IUnwrapParameters) {
        if (parameters.amount < TransactionBuilder.MINIMUM_DUST) {
            throw new Error('Amount is below dust limit');
        }

        parameters.disableAutoRefund = true; // we have to disable auto refund for this transaction, so it does not create an unwanted output.
        parameters.calldata = UnwrapTransaction.generateBurnCalldata(parameters.amount);

        super(parameters);

        this.wbtc = new wBTC(parameters.network);
        this.to = this.wbtc.getAddress();

        this.vaultUTXOs = parameters.unwrapUTXOs;

        this.amount = parameters.amount;
        this.contractSecret = this.generateSecret();

        this.compiledTargetScript = this.calldataGenerator.compile(
            this.calldata,
            this.contractSecret,
        );

        this.scriptTree = this.getScriptTree();
        this.internalInit();
    }

    /**
     * Generate a valid wBTC calldata
     * @param {bigint} amount - The amount to wrap
     * @private
     * @returns {Buffer} - The calldata
     */
    public static generateBurnCalldata(amount: bigint): Buffer {
        if (!amount) throw new Error('Amount is required');

        const bufWriter: BinaryWriter = new BinaryWriter();
        bufWriter.writeSelector(UnwrapTransaction.UNWRAP_SELECTOR);
        bufWriter.writeU256(amount);

        return Buffer.from(bufWriter.getBuffer());
    }

    /**
     * @description Signs the transaction
     * @public
     * @returns {Transaction} - The signed transaction in hex format
     * @throws {Error} - If something went wrong
     */
    public signPSBT(): Psbt {
        if (this.to && !EcKeyPair.verifyContractAddress(this.to, this.network)) {
            throw new Error(
                'Invalid contract address. The contract address must be a taproot address.',
            );
        }

        if (!this.vaultUTXOs.length) {
            throw new Error('No vault UTXOs provided');
        }

        if (this.signed) throw new Error('Transaction is already signed');
        this.signed = true;

        this.buildTransaction();

        this.ignoreSignatureError();
        this.mergeVaults(this.vaultUTXOs);

        const builtTx = this.internalBuildTransaction(this.transaction);
        if (builtTx) {
            return this.transaction;
        }

        throw new Error('Could not sign transaction');
    }

    /**
     * @description Merge vault UTXOs into the transaction
     * @param {VaultUTXOs[]} input The vault UTXOs
     * @public
     */
    public mergeVaults(input: VaultUTXOs[]): void {
        const firstVault = input[0];
        if (!firstVault) {
            throw new Error('No vaults provided');
        }

        const outputLeftAmount = this.calculateOutputLeftAmountFromVaults(input);
        if (outputLeftAmount < 0) {
            throw new Error(
                `Output left amount is negative ${outputLeftAmount} for vault ${firstVault.vault}`,
            );
        }

        console.log('outputLeftAmount', outputLeftAmount, this.amount);

        if (outputLeftAmount < UnwrapTransaction.MINIMUM_CONSOLIDATION_AMOUNT) {
            throw new Error(
                `Output left amount is below minimum consolidation (${UnwrapTransaction.MINIMUM_CONSOLIDATION_AMOUNT} sat) amount ${outputLeftAmount} for vault ${firstVault.vault}`,
            );
        }

        this.addOutput({
            address: firstVault.vault,
            value: Number(outputLeftAmount),
        });

        this.addOutput({
            address: this.from,
            value: Number(this.amount),
        });

        for (const vault of input) {
            this.addVaultInputs(vault);
        }
    }

    public estimateVaultFees(
        feeRate: bigint, // satoshis per byte
        numInputs: bigint,
        numOutputs: bigint,
        numSignatures: bigint,
        numPubkeys: bigint,
    ): bigint {
        const txHeaderSize = 10n;
        const inputBaseSize = 41n;
        const outputSize = 68n;
        const signatureSize = 144n;
        const pubkeySize = 34n;

        // Base transaction size (excluding witness data)
        const baseTxSize = txHeaderSize + inputBaseSize * numInputs + outputSize * numOutputs;

        // Witness data size
        const redeemScriptSize = 1n + numPubkeys * (1n + pubkeySize) + 1n + numSignatures;
        const witnessSize =
            numSignatures * signatureSize + numPubkeys * pubkeySize + redeemScriptSize;

        // Total weight and virtual size
        const weight = baseTxSize * 3n + (baseTxSize + witnessSize);
        const vSize = weight / 4n;

        return vSize * feeRate;
    }

    /**
     * Builds the transaction.
     * @param {Psbt} transaction - The transaction to build
     * @protected
     * @returns {boolean}
     * @throws {Error} - If something went wrong while building the transaction
     */
    protected internalBuildTransaction(transaction: Psbt): boolean {
        if (transaction.data.inputs.length === 0) {
            const inputs: PsbtInputExtended[] = this.getInputs();
            const outputs: PsbtOutputExtended[] = this.getOutputs();

            transaction.setMaximumFeeRate(this._maximumFeeRate);
            transaction.addInputs(inputs);

            for (let i = 0; i < this.updateInputs.length; i++) {
                transaction.updateInput(i, this.updateInputs[i]);
            }

            transaction.addOutputs(outputs);
        }

        try {
            this.signInputs(transaction);

            if (this.finalized) {
                this.transactionFee = BigInt(transaction.getFee());
            }

            return true;
        } catch (e) {
            const err: Error = e as Error;

            this.error(
                `[internalBuildTransaction] Something went wrong while getting building the transaction: ${err.stack}`,
            );
        }

        return false;
    }

    /**
     * Generate a multi-signature redeem script
     * @param {string[]} publicKeys The public keys
     * @param {number} minimum The minimum number of signatures
     * @protected
     * @returns {{output: Buffer; redeem: Buffer}} The output and redeem script
     */
    protected generateMultiSignRedeemScript(
        publicKeys: string[],
        minimum: number,
    ): { witnessUtxo: Buffer; redeemScript: Buffer; witnessScript: Buffer } {
        const p2ms = payments.p2ms({
            m: minimum,
            pubkeys: publicKeys.map((key) => Buffer.from(key, 'base64')),
            network: this.network,
        });

        const p2wsh = payments.p2wsh({
            redeem: p2ms,
            network: this.network,
        });

        const witnessUtxo = p2wsh.output;
        const redeemScript = p2wsh.redeem?.output;
        const witnessScript = p2ms.output;

        if (!witnessUtxo || !redeemScript || !witnessScript) {
            throw new Error('Failed to generate redeem script');
        }

        return {
            witnessUtxo,
            redeemScript,
            witnessScript,
        };
    }

    /**
     * @description Add a vault UTXO to the transaction
     * @private
     */
    private addVaultUTXO(
        utxo: IWBTCUTXODocument,
        witness: {
            witnessUtxo: Buffer;
            redeemScript: Buffer;
            witnessScript: Buffer;
        },
    ): void {
        console.log(Number(utxo.value), utxo.hash, utxo.outputIndex);
        const input: PsbtInputExtended = {
            hash: utxo.hash,
            index: utxo.outputIndex,
            witnessUtxo: {
                script: Buffer.from(utxo.output, 'base64'),
                value: Number(utxo.value),
            },
            witnessScript: witness.witnessScript,
            sequence: this.sequence,
        };

        if (this.calculatedSignHash) {
            input.sighashType = this.calculatedSignHash;
        }

        this.addInput(input);
    }

    /**
     * @description Add vault inputs to the transaction
     * @param {VaultUTXOs} vault The vault UTXOs
     * @param {Signer} [firstSigner] The first signer
     * @private
     */
    private addVaultInputs(vault: VaultUTXOs, firstSigner: Signer = this.signer): void {
        const p2wshOutput = this.generateMultiSignRedeemScript(vault.publicKeys, vault.minimum);
        for (const utxo of vault.utxos) {
            const inputIndex = this.transaction.inputCount;
            this.addVaultUTXO(utxo, p2wshOutput);

            if (firstSigner) {
                this.log(
                    `Signing input ${inputIndex} with ${firstSigner.publicKey.toString('hex')}`,
                );

                // we don't care if we fail to sign the input
                try {
                    this.signInput(
                        this.transaction,
                        this.transaction.data.inputs[inputIndex],
                        inputIndex,
                        this.signer,
                    );

                    this.log(
                        `Signed input ${inputIndex} with ${firstSigner.publicKey.toString('hex')}`,
                    );
                } catch (e) {
                    if (!this.ignoreSignatureErrors) {
                        this.warn(
                            `Failed to sign input ${inputIndex} with ${firstSigner.publicKey.toString('hex')} ${(e as Error).message}`,
                        );
                    }
                }
            }
        }
    }

    /**
     * @description Calculate the amount left to refund to the first vault.
     * @param {VaultUTXOs[]} vaults The vaults
     * @private
     * @returns {bigint} The amount left
     */
    private calculateOutputLeftAmountFromVaults(vaults: VaultUTXOs[]): bigint {
        const total = this.getVaultTotalOutputAmount(vaults);

        return total - this.amount;
    }

    private getVaultTotalOutputAmount(vaults: VaultUTXOs[]): bigint {
        let total = BigInt(0);
        for (const vault of vaults) {
            for (const utxo of vault.utxos) {
                total += BigInt(utxo.value);
            }
        }

        return total;
    }
}
