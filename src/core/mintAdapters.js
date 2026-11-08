'use strict';

const { Interface, getAddress, isAddress, isHexString } = require('ethers');
const { MintSpecError } = require('./errors');
const thirdweb = require('./adapters/thirdweb');

const DIRECT_SIGNATURES = new Map([
  ['mint()', { label: 'mint()', args: [], valueMode: 'total' }],
  ['mint(uint256)', { label: 'mint(quantity)', args: ['quantity'], valueMode: 'perQuantity' }],
  ['publicMint(uint256)', { label: 'publicMint(quantity)', args: ['quantity'], valueMode: 'perQuantity' }],
  ['mint(address,uint256)', { label: 'mint(to, quantity)', args: ['wallet', 'quantity'], valueMode: 'perQuantity' }],
  ['safeMint(address,uint256)', { label: 'safeMint(to, quantity)', args: ['wallet', 'quantity'], valueMode: 'perQuantity' }],
  ['publicMint(address,uint256)', { label: 'publicMint(to, quantity)', args: ['wallet', 'quantity'], valueMode: 'perQuantity' }]
]);

const MERKLE_SIGNATURES = new Map([
  ['mint(uint256,bytes32[])', { label: 'Merkle mint(quantity, proof)', fields: ['quantity', 'proof'] }],
  ['mint(bytes32[],uint256)', { label: 'Merkle mint(proof, quantity)', fields: ['proof', 'quantity'] }],
  ['mint(address,uint256,bytes32[])', { label: 'Merkle mint(to, quantity, proof)', fields: ['wallet', 'quantity', 'proof'] }],
  ['mint(address,uint256,uint256,bytes32[])', { label: 'Merkle mint(to, quantity, maxQuantity, proof)', fields: ['wallet', 'quantity', 'maxQuantity', 'proof'] }],
  ['whitelistMint(uint256,bytes32[])', { label: 'Whitelist mint(quantity, proof)', fields: ['quantity', 'proof'] }],
  ['allowlistMint(uint256,bytes32[])', { label: 'Allowlist mint(quantity, proof)', fields: ['quantity', 'proof'] }],
  ['publicMint(uint256,bytes32[])', { label: 'Allowlist publicMint(quantity, proof)', fields: ['quantity', 'proof'] }]
]);

const SIGNATURE_SIGNATURES = new Map([
  ['mint(uint256,uint256,uint256,bytes)', { label: 'Signature mint(quantity, maxQuantity, deadline, signature)', fields: ['quantity', 'maxQuantity', 'deadline', 'signature'] }],
  ['mint(uint256,uint256,uint256,uint256,bytes)', { label: 'Signature mint(quantity, maxQuantity, nonce, deadline, signature)', fields: ['quantity', 'maxQuantity', 'nonce', 'deadline', 'signature'] }],
  ['mint(address,uint256,uint256,uint256,bytes)', { label: 'Signature mint(to, quantity, maxQuantity, deadline, signature)', fields: ['wallet', 'quantity', 'maxQuantity', 'deadline', 'signature'] }],
  ['mint(address,uint256,uint256,uint256,uint256,bytes)', { label: 'Signature mint(to, quantity, maxQuantity, nonce, deadline, signature)', fields: ['wallet', 'quantity', 'maxQuantity', 'nonce', 'deadline', 'signature'] }],
  ['mintWithSignature(address,uint256,uint256,uint256,bytes)', { label: 'Signature mintWithSignature(to, quantity, nonce, deadline, signature)', fields: ['wallet', 'quantity', 'nonce', 'deadline', 'signature'] }],
  ['whitelistMint(uint256,uint256,uint256,bytes)', { label: 'Signature whitelistMint(quantity, maxQuantity, deadline, signature)', fields: ['quantity', 'maxQuantity', 'deadline', 'signature'] }],
  ['allowlistMint(uint256,uint256,uint256,bytes)', { label: 'Signature allowlistMint(quantity, maxQuantity, deadline, signature)', fields: ['quantity', 'maxQuantity', 'deadline', 'signature'] }]
]);

const DIRECT_INTERFACE = new Interface([...DIRECT_SIGNATURES.keys()].map((s) => `function ${s} payable`));
const SEADROP_INTERFACE = new Interface([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable'
]);
const SEADROP_SIGNED_INTERFACE = new Interface([
  'function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable'
]);
const SEADROP_REST_INTERFACE = new Interface([
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  'function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,bytes32[] proof) payable',
  'function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature) payable',
  'function mintAllowedTokenHolder(address nftContract,address feeRecipient,address minterIfNotPayer,(address allowedNftToken,uint256[] allowedNftTokenIds) mintParams) payable'
]);
const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';
const MERKLE_INTERFACE = new Interface([...MERKLE_SIGNATURES.keys()].map((s) => `function ${s} payable`));
const SIGNATURE_INTERFACE = new Interface([...SIGNATURE_SIGNATURES.keys()].map((s) => `function ${s} payable`));

function asObject(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') {
    try { return JSON.parse(spec); } catch { throw new MintSpecError('Mint adapter configuration is not valid JSON.'); }
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new MintSpecError('Mint adapter configuration must be an object.');
  return spec;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new MintSpecError(`${label} must be a positive integer.`);
  return n;
}

function wei(value, label) {
  try {
    const n = BigInt(value);
    if (n < 0n) throw new MintSpecError();
    return n;
  } catch {
    throw new MintSpecError(`${label} must be a non-negative integer in wei.`);
  }
}

function uint(value, label) {
  try {
    const n = BigInt(value);
    if (n < 0n) throw new MintSpecError();
    return n;
  } catch {
    throw new MintSpecError(`${label} must be a non-negative integer.`);
  }
}

function address(value, label) {
  if (!isAddress(value)) throw new MintSpecError(`${label} must be a valid EVM address.`);
  return getAddress(value);
}

function bytes(value, label) {
  if (!isHexString(value) || value.length <= 2) throw new MintSpecError(`${label} must be a non-empty hex byte string.`);
  return value;
}

function proof(value) {
  if (!Array.isArray(value)) throw new MintSpecError('Merkle proof must be an array of bytes32 hashes.');
  return value.map((item, index) => {
    if (!isHexString(item, 32)) throw new MintSpecError(`Merkle proof item ${index + 1} must be a bytes32 hash.`);
    return item;
  });
}

function targetAndRecipient(spec, schedule, targetLabel = 'Mint target') {
  const target = address(spec.target || schedule.contract, targetLabel);
  if (target.toLowerCase() !== String(schedule.contract).toLowerCase()) throw new MintSpecError('Mint target must match the scheduled NFT contract.');
  const recipient = address(spec.wallet || schedule.wallet_address, 'Recipient');
  if (recipient.toLowerCase() !== String(schedule.wallet_address).toLowerCase()) throw new MintSpecError('Mint recipient must match the scheduled wallet.');
  return { target, recipient };
}

/** SeaDrop calldata names the NFT contract explicitly; it must be the scheduled contract. */
function boundNftContract(spec, schedule) {
  const nftContract = address(spec.nftContract || schedule.contract, 'NFT contract');
  if (nftContract.toLowerCase() !== String(schedule.contract).toLowerCase()) throw new MintSpecError('SeaDrop nftContract must match the scheduled NFT contract.');
  return nftContract;
}

function normalizeDirect(spec, schedule) {
  const signature = spec.signature || spec.function;
  const definition = DIRECT_SIGNATURES.get(signature);
  if (!definition) throw new MintSpecError('Unsupported direct mint signature.');
  const quantity = definition.args.includes('quantity') ? positiveInt(spec.quantity ?? schedule.quantity, 'Quantity') : 1;
  const { target, recipient } = targetAndRecipient(spec, schedule);
  const args = definition.args.map((arg) => arg === 'quantity' ? BigInt(quantity) : recipient);
  const priceWei = wei(spec.priceWei ?? schedule.price_wei ?? 0, 'Price');
  const valueWei = definition.valueMode === 'perQuantity' ? priceWei * BigInt(quantity) : priceWei;
  return { target, data: DIRECT_INTERFACE.encodeFunctionData(signature, args), valueWei, quantity, label: definition.label, adapter: 'direct' };
}

function normalizeSeaDrop(spec, schedule) {
  const target = address(spec.seaDropContract || spec.target, 'SeaDrop contract');
  const nftContract = boundNftContract(spec, schedule);
  const quantity = positiveInt(spec.quantity ?? schedule.quantity, 'Quantity');
  const mintPrice = wei(spec.mintPrice ?? schedule.price_wei ?? 0, 'Public-drop mint price');
  const feeRecipient = address(spec.feeRecipient, 'SeaDrop fee recipient');
  const minter = spec.minterIfNotPayer ? address(spec.minterIfNotPayer, 'SeaDrop mint recipient') : '0x0000000000000000000000000000000000000000';
  const feeBps = Number(spec.feeBps ?? 0);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new MintSpecError('SeaDrop fee basis points are invalid.');
  if ((feeBps > 0 || spec.restrictFeeRecipients === true) && feeRecipient === '0x0000000000000000000000000000000000000000') throw new MintSpecError('SeaDrop requires a non-zero fee recipient for this drop.');
  if (minter !== '0x0000000000000000000000000000000000000000' && minter.toLowerCase() !== String(schedule.wallet_address).toLowerCase()) throw new MintSpecError('SeaDrop recipient must match the scheduled wallet.');
  const data = SEADROP_INTERFACE.encodeFunctionData('mintPublic', [nftContract, feeRecipient, minter, quantity]);
  return { target, data, valueWei: mintPrice * BigInt(quantity), quantity, label: 'SeaDrop public mint', adapter: 'seadrop', nftContract, feeRecipient };
}

function normalizeSeaDropSigned(spec, schedule) {
  const target = address(spec.seaDropContract || spec.target, 'SeaDrop contract');
  const nftContract = boundNftContract(spec, schedule);
  const quantity = positiveInt(spec.quantity ?? schedule.quantity, 'Quantity');
  const feeRecipient = address(spec.feeRecipient, 'SeaDrop fee recipient');
  const minter = spec.minterIfNotPayer ? address(spec.minterIfNotPayer, 'SeaDrop mint recipient') : '0x0000000000000000000000000000000000000000';
  if (minter !== '0x0000000000000000000000000000000000000000' && minter.toLowerCase() !== String(schedule.wallet_address).toLowerCase()) throw new MintSpecError('SeaDrop signed recipient must match the scheduled wallet.');
  const p = spec.mintParams || spec.params;
  const deferred = (!p || !(spec.signature || spec.mintSignature)) && (spec.providerId || spec.signatureProvider);
  if (deferred) {
    const mintPrice = uint(spec.mintPrice ?? spec.priceWei ?? schedule.price_wei ?? 0, 'SeaDrop signed mint price');
    return { target, data: '0x', valueWei: mintPrice * BigInt(quantity), quantity, label: 'SeaDrop signed mint (provider-backed)', adapter: 'seadrop-signed', nftContract, feeRecipient, minterIfNotPayer: minter, deferred: true };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new MintSpecError('SeaDrop signed mintParams are required.');
  const mintParams = {
    mintPrice: uint(p.mintPrice, 'MintParams.mintPrice'),
    maxTotalMintableByWallet: uint(p.maxTotalMintableByWallet, 'MintParams.maxTotalMintableByWallet'),
    startTime: uint(p.startTime, 'MintParams.startTime'),
    endTime: uint(p.endTime, 'MintParams.endTime'),
    dropStageIndex: uint(p.dropStageIndex, 'MintParams.dropStageIndex'),
    maxTokenSupplyForStage: uint(p.maxTokenSupplyForStage, 'MintParams.maxTokenSupplyForStage'),
    feeBps: uint(p.feeBps, 'MintParams.feeBps'),
    restrictFeeRecipients: Boolean(p.restrictFeeRecipients)
  };
  if (mintParams.dropStageIndex === 0n) throw new MintSpecError('MintParams.dropStageIndex must be non-zero for a signed SeaDrop mint.');
  if (mintParams.feeBps > 10000n) throw new MintSpecError('MintParams.feeBps must not exceed 10000.');
  if (mintParams.restrictFeeRecipients && feeRecipient === '0x0000000000000000000000000000000000000000') throw new MintSpecError('SeaDrop signed mint requires a non-zero fee recipient when recipients are restricted.');
  if (mintParams.endTime <= mintParams.startTime) throw new MintSpecError('MintParams.endTime must be after startTime.');
  const salt = uint(spec.salt, 'SeaDrop signed salt');
  const signed = bytes(spec.signature || spec.mintSignature, 'SeaDrop signed authorization');
  const data = SEADROP_SIGNED_INTERFACE.encodeFunctionData('mintSigned', [
    nftContract, feeRecipient, minter, quantity,
    [mintParams.mintPrice, mintParams.maxTotalMintableByWallet, mintParams.startTime, mintParams.endTime,
      mintParams.dropStageIndex, mintParams.maxTokenSupplyForStage, mintParams.feeBps, mintParams.restrictFeeRecipients],
    salt, signed
  ]);
  return {
    target, data, valueWei: mintParams.mintPrice * BigInt(quantity), quantity,
    label: 'SeaDrop signed mint', adapter: 'seadrop-signed', nftContract, feeRecipient,
    minterIfNotPayer: minter, mintParams: Object.fromEntries(Object.entries(mintParams).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])), salt: salt.toString()
  };
}

function normalizeOpenSeaDrop(spec, schedule) {
  const slug = String(spec.slug || '');
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(slug)) throw new MintSpecError('OpenSea collection slug is invalid.');
  const expectedQuantity = positiveInt(spec.quantity ?? schedule.quantity, 'Quantity');
  if (expectedQuantity > 100) throw new MintSpecError('OpenSea mint quantity must be between 1 and 100.');
  if (schedule.quantity !== undefined && expectedQuantity !== Number(schedule.quantity)) throw new MintSpecError('OpenSea mint quantity does not match the schedule.');
  const maxPriceWei = wei(spec.priceWei ?? schedule.price_wei ?? 0, 'OpenSea maximum price per NFT');
  if (schedule.price_wei !== undefined && maxPriceWei !== wei(schedule.price_wei, 'Scheduled maximum price per NFT')) throw new MintSpecError('Stored OpenSea spend ceiling does not match the schedule.');
  const tx = spec.transaction;
  if (!tx) return { target: null, data: '0x', valueWei: maxPriceWei * BigInt(expectedQuantity), quantity: expectedQuantity, label: 'OpenSea REST SeaDrop mint', adapter: 'opensea-drop', eligibility: 'opensea-rest', slug, pending: true };
  if (typeof tx !== 'object' || Array.isArray(tx)) throw new MintSpecError('OpenSea mint transaction must be refreshed before signing.');
  if (String(tx.chain || '').toLowerCase() !== String(schedule.chain || '').toLowerCase()) throw new MintSpecError('OpenSea transaction is for a different chain.');
  const target = address(tx.to, 'OpenSea SeaDrop transaction target');
  const data = bytes(tx.data, 'OpenSea transaction calldata');
  if (data.length > 100000) throw new MintSpecError('OpenSea transaction calldata is too large.');
  let parsed;
  try { parsed = SEADROP_REST_INTERFACE.parseTransaction({ data }); } catch { parsed = null; }
  if (!parsed) throw new MintSpecError('OpenSea returned an unsupported SeaDrop mint function.');

  const args = parsed.args;
  const nftContract = address(args[0], 'OpenSea NFT contract');
  if (nftContract.toLowerCase() !== String(schedule.contract).toLowerCase()) throw new MintSpecError('OpenSea transaction targets a different NFT contract.');
  const feeRecipient = address(args[1], 'OpenSea fee recipient');
  const feeBps = Number(spec.feeBps ?? 1000);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new MintSpecError('OpenSea fee basis points are invalid.');
  const openSeaFee = OPENSEA_FEE_RECIPIENT.toLowerCase();
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  if (feeRecipient.toLowerCase() !== openSeaFee && !(feeBps === 0 && feeRecipient.toLowerCase() === zeroAddress)) {
    throw new MintSpecError('OpenSea transaction uses an unexpected primary-sale fee recipient.');
  }
  const minterIfNotPayer = address(args[2], 'OpenSea mint recipient');
  if (minterIfNotPayer.toLowerCase() !== zeroAddress && minterIfNotPayer.toLowerCase() !== String(schedule.wallet_address).toLowerCase()) {
    throw new MintSpecError('OpenSea transaction mint recipient does not match the scheduled wallet.');
  }

  const quantity = parsed.name === 'mintAllowedTokenHolder'
    ? BigInt(args[3].allowedNftTokenIds.length)
    : BigInt(args[3]);
  if (quantity !== BigInt(expectedQuantity) || (schedule.quantity !== undefined && quantity !== BigInt(schedule.quantity))) throw new MintSpecError('OpenSea transaction quantity does not match the scheduled quantity.');
  if (!/^\d+$/.test(String(tx.value))) throw new MintSpecError('OpenSea transaction value must be a decimal wei string.');
  const valueWei = wei(tx.value, 'OpenSea transaction value');
  return { target, data, valueWei, quantity: expectedQuantity, label: 'OpenSea REST SeaDrop mint', adapter: 'opensea-drop', eligibility: 'opensea-rest', slug, feeRecipient, feeBps };
}

function normalizeTokenGate(spec, schedule) {
  const standard = String(spec.standard || 'erc721').toLowerCase();
  if (!['erc20', 'erc721', 'erc1155'].includes(standard)) throw new MintSpecError('Token gate standard must be erc20, erc721, or erc1155.');
  const gateContract = address(spec.gateContract, 'Token gate contract');
  const minBalance = uint(spec.minBalance ?? 1, 'Minimum gate balance');
  if (minBalance < 1n) throw new MintSpecError('Minimum gate balance must be positive.');
  const tokenId = standard === 'erc1155' ? uint(spec.tokenId, 'ERC-1155 token ID') : (spec.tokenId == null ? null : uint(spec.tokenId, 'Token ID'));
  const direct = normalizeDirect({ ...spec, signature: spec.mintFunction || spec.signature }, schedule);
  return { ...direct, adapter: 'token', eligibility: 'token', gateContract, gateStandard: standard, minBalance: minBalance.toString(), tokenId: tokenId == null ? null : tokenId.toString() };
}

function fieldValue(field, spec, schedule, quantity) {
  if (field === 'wallet') return targetAndRecipient(spec, schedule).recipient;
  if (field === 'quantity') return BigInt(quantity);
  if (field === 'maxQuantity') return uint(spec.maxQuantity, 'Max quantity');
  if (field === 'nonce') return uint(spec.nonce, 'Nonce');
  if (field === 'deadline') return uint(spec.deadline, 'Deadline');
  if (field === 'proof') return proof(spec.proof);
  if (field === 'signature') return bytes(spec.signature, 'Mint signature');
  throw new MintSpecError(`Unsupported eligibility field: ${field}`);
}

function normalizeEligibility(spec, schedule, definitions, iface, adapter) {
  const signature = spec.signatureFunction || spec.mintFunction || spec.function;
  const definition = definitions.get(signature);
  if (!definition) throw new MintSpecError(`Unsupported ${adapter} mint signature.`);
  const { target } = targetAndRecipient(spec, schedule);
  const quantity = positiveInt(spec.quantity ?? schedule.quantity, 'Quantity');
  const missing = adapter === 'merkle' ? spec.proof === undefined : spec.signature === undefined;
  if (missing && spec.providerId) {
    // Provider-backed: proof/signature are fetched fresh for each wallet immediately before signing.
    const priceWei = wei(spec.priceWei ?? schedule.price_wei ?? 0, 'Price');
    return { target, data: '0x', valueWei: priceWei * BigInt(quantity), quantity, label: `${definition.label} (provider-backed)`, adapter, eligibility: adapter, deferred: true };
  }
  const values = definition.fields.map((field) => fieldValue(field, spec, schedule, quantity));
  const maxQuantityIndex = definition.fields.indexOf('maxQuantity');
  if (maxQuantityIndex !== -1 && values[maxQuantityIndex] < BigInt(quantity)) throw new MintSpecError('Max quantity must be at least the requested quantity.');
  const priceWei = wei(spec.priceWei ?? schedule.price_wei ?? 0, 'Price');
  const result = {
    target,
    data: iface.encodeFunctionData(signature, values),
    valueWei: priceWei * BigInt(quantity),
    quantity,
    label: definition.label,
    adapter,
    eligibility: adapter
  };
  if (adapter === 'merkle') result.proof = proof(spec.proof);
  if (adapter === 'signature') result.signatureBytes = bytes(spec.signature, 'Mint signature');
  return result;
}

// Keys a user may type into the adapter JSON in the bot wizard. Everything else is rejected:
// in particular file paths and URLs (eligibility data comes only from operator providers).
const USER_KEYS = {
  merkle: ['adapter', 'signatureFunction', 'quantity', 'priceWei', 'proof', 'providerId'],
  signature: ['adapter', 'mintFunction', 'quantity', 'priceWei', 'maxQuantity', 'nonce', 'deadline', 'signature', 'providerId'],
  token: ['adapter', 'mintFunction', 'quantity', 'priceWei', 'gateContract', 'standard', 'minBalance', 'tokenId'],
  'seadrop-signed': ['adapter', 'providerId', 'seaDropContract', 'nftContract', 'feeRecipient', 'minterIfNotPayer', 'quantity', 'priceWei'],
  'opensea-drop': ['adapter', 'slug', 'quantity', 'priceWei'],
  'thirdweb-drop': thirdweb.USER_KEYS
};
// Keys a persisted schedule spec may carry: user keys plus fields MintPilot itself fills in
// (SeaDrop public-drop data from discovery, the live signed-mint price, OpenSea fee bps).
const STORED_KEYS = {
  ...USER_KEYS,
  direct: ['adapter', 'signature', 'quantity', 'priceWei'],
  seadrop: ['adapter', 'seaDropContract', 'nftContract', 'mintPrice', 'feeBps', 'restrictFeeRecipients', 'feeRecipient', 'minterIfNotPayer', 'quantity'],
  'seadrop-signed': [...USER_KEYS['seadrop-signed'], 'mintPrice'],
  'opensea-drop': [...USER_KEYS['opensea-drop'], 'feeBps'],
  'thirdweb-drop': thirdweb.STORED_KEYS
};
// Adapters whose transaction goes to a SeaDrop router; the router must be in the NFT's allowed list.
const SEADROP_ROUTES = new Set(['seadrop', 'seadrop-signed', 'opensea-drop']);

function assertSpecKeys(specInput, mode = 'stored') {
  const spec = asObject(specInput);
  const table = mode === 'user' ? USER_KEYS : STORED_KEYS;
  const allowed = spec && table[spec.adapter];
  if (!allowed) throw new MintSpecError(`Unsupported mint adapter: ${spec && spec.adapter}`);
  const extra = Object.keys(spec).filter((key) => !allowed.includes(key));
  if (extra.length) throw new MintSpecError(`Unsupported field${extra.length > 1 ? 's' : ''} for the ${spec.adapter} adapter: ${extra.join(', ')}`);
  return spec;
}

const isSeaDropRoute = (adapter) => SEADROP_ROUTES.has(adapter);

function buildFromSpec(specInput, schedule) {
  const spec = asObject(specInput);
  if (!spec || !spec.adapter) throw new MintSpecError('Mint adapter configuration is missing.');
  if (spec.adapter === 'direct') return normalizeDirect(spec, schedule);
  if (spec.adapter === 'seadrop') return normalizeSeaDrop(spec, schedule);
  if (spec.adapter === 'seadrop-signed') return normalizeSeaDropSigned(spec, schedule);
  if (spec.adapter === 'opensea-drop') return normalizeOpenSeaDrop(spec, schedule);
  if (spec.adapter === 'token') return normalizeTokenGate(spec, schedule);
  if (spec.adapter === 'thirdweb-drop') return thirdweb.normalize(spec, schedule);
  if (spec.adapter === 'merkle') return normalizeEligibility(spec, schedule, MERKLE_SIGNATURES, MERKLE_INTERFACE, 'merkle');
  if (spec.adapter === 'signature') return normalizeEligibility(spec, schedule, SIGNATURE_SIGNATURES, SIGNATURE_INTERFACE, 'signature');
  throw new MintSpecError(`Unsupported mint adapter: ${spec.adapter}`);
}

module.exports = { DIRECT_SIGNATURES, MERKLE_SIGNATURES, SIGNATURE_SIGNATURES, USER_KEYS, STORED_KEYS, buildFromSpec, assertSpecKeys, isSeaDropRoute };
