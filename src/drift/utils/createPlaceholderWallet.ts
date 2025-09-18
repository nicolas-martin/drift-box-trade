import { Keypair, PublicKey } from '@solana/web3.js';
import { IWallet } from '@drift-labs/sdk';

export const createPlaceholderIWallet = (walletPubKey?: PublicKey): IWallet => {
	const newKeypair = walletPubKey
		? new Keypair({
				publicKey: walletPubKey.toBytes(),
				secretKey: new Keypair().publicKey.toBytes(),
		  })
		: new Keypair();

	return {
		publicKey: newKeypair.publicKey,
		// @ts-ignore - placeholder wallet should never sign
		signTransaction: () => Promise.resolve(),
		// @ts-ignore - placeholder wallet should never sign
		signAllTransactions: () => Promise.resolve(),
	};
};
