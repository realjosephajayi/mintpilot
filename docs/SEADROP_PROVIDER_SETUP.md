# SeaDrop provider setup

This template is for the upcoming Robinhood Chain mint. It uses the successful transaction as a configuration reference, but the live signature endpoint must provide fresh values for each wallet and mint attempt.

## Environment variables

Add these to the deployment environment. Do not commit the real API key or bearer token.

```env
# Mainnet RPC and automatic execution
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
AUTOMATION_ENABLED=true
AUTOMATION_DRY_RUN=true            # false only after a dry run against the real provider passes
AUTOMATION_ALLOWED_CHAINS=robinhood
AUTOMATION_MAX_VALUE_ETH=0.2
AUTOMATION_MASTER_KEY=<64 hexadecimal characters / 32 bytes>

# Secure SeaDrop signature provider (kind is required in ELIGIBILITY_PROVIDERS_JSON)
ELIGIBILITY_PROVIDERS_JSON={"goat-ranch-upcoming":{"kind":"seadrop-signed","url":"https://REPLACE_WITH_OFFICIAL_PROJECT_API/mint-signature","method":"POST","chain":"robinhood","contract":"0x95a85681e28988B4Ef503369470B4da7681c4BC8","headers":{"authorization":"Bearer REPLACE_WITH_PROVIDER_SECRET"}}}
```

`AUTOMATION_MASTER_KEY` must remain unchanged after wallets are imported. Changing it makes existing encrypted wallet keys unreadable. Generate a new value with:

```bash
openssl rand -hex 32
```

The provider URL must be HTTPS in production. The provider secret belongs in the server environment only; do not put it in Telegram, a schedule JSON object, or a browser page.

## Schedule configuration

Use this in the SeaDrop signed adapter configuration:

```json
{
  "adapter": "seadrop-signed",
  "providerId": "goat-ranch-upcoming",
  "seaDropContract": "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
  "nftContract": "0x95a85681e28988B4Ef503369470B4da7681c4BC8",
  "feeRecipient": "0x0000a26b00c1F0DF003000390027140000fAa719",
  "quantity": 1
}
```

`nftContract` must equal the contract you entered in the wizard (or be omitted). The wizard calls the
provider once for your first wallet and stores the returned `mintParams.mintPrice` as the price; at mint
time a fresh signature is fetched per wallet and a higher live price is refused. The provider should return
HTTP 429/5xx for "try again later" (retried) and 4xx for "not eligible" (the schedule stops).

The contract and fee recipient above are from the observed successful Goat Ranch Club transaction. Verify them against the upcoming project instructions before scheduling. If the upcoming phase uses a different fee recipient, price, or collection contract, replace those values.

## Expected provider request

MintPilot sends a `POST` request with:

```json
{
  "address": "<scheduled wallet address>",
  "wallet": "<scheduled wallet address>",
  "chain": "robinhood",
  "contract": "0x95a85681e28988B4Ef503369470B4da7681c4BC8",
  "quantity": 1
}
```

## Expected provider response

The provider must return a fresh response for the requested wallet:

```json
{
  "address": "<same scheduled wallet address>",
  "nftContract": "0x95a85681e28988B4Ef503369470B4da7681c4BC8",
  "chain": "robinhood",
  "quantity": 1,
  "signature": "0x<fresh 65-byte signature>",
  "salt": "<fresh uint256 salt>",
  "mintParams": {
    "mintPrice": "0",
    "maxTotalMintableByWallet": "1",
    "startTime": "<upcoming phase start Unix timestamp>",
    "endTime": "<upcoming phase end Unix timestamp>",
    "dropStageIndex": "3",
    "maxTokenSupplyForStage": "10000",
    "feeBps": "1000",
    "restrictFeeRecipients": true
  }
}
```

The response may also be wrapped as `{ "data": { ... } }`.

MintPilot rejects the response if the wallet, chain, contract, or quantity differs from the schedule. It then encodes `mintSigned`, calculates the exact transaction value, runs on-chain simulation, estimates gas, and only then attempts submission.

## Before enabling the live schedule

Confirm all of the following:

- The provider is the project’s official mint/signature endpoint.
- The provider issues signatures for the actual MintPilot wallet address.
- The endpoint returns current phase times, not the historical transaction’s values.
- The fee recipient is valid for the NFT contract when `restrictFeeRecipients` is true.
- The SeaDrop router is allowed by the NFT contract.
- The imported or generated wallet has enough Robinhood Chain ETH for gas.
- The exact final transaction passes `eth_call` simulation.
- A fresh signature and salt are requested for each wallet and quantity.

Do not reuse the historical transaction’s signature or salt. SeaDrop signatures are tied to the NFT contract, minter, fee recipient, full `MintParams`, and salt, and each signed digest can be used only once.
