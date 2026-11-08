'use strict';

const { getAddress, isAddress, Contract } = require('ethers');
const { DIRECT_SIGNATURES } = require('./mintAdapters');
const thirdweb = require('./adapters/thirdweb');

const ERC165 = '0x01ffc9a7';
const ERC721 = '0x80ac58cd';
const ERC1155 = '0xd9b67a26';
const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const READ_ABI = [
  'function name() view returns(string)', 'function symbol() view returns(string)',
  'function totalSupply() view returns(uint256)', 'function maxSupply() view returns(uint256)',
  'function supportsInterface(bytes4) view returns(bool)'
];
const SEADROP_TOKEN_ABI = ['function getAllowedSeaDrop() view returns(address[])'];
const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns(tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getCreatorPayoutAddress(address nftContract) view returns(address)',
  'function getAllowedFeeRecipients(address nftContract) view returns(address[])'
];

function slotAddress(value) {
  if (!value || value === '0x' || /^0x0+$/.test(value)) return null;
  const raw = `0x${value.slice(-40)}`;
  return isAddress(raw) ? getAddress(raw) : null;
}

function minimalProxyImplementation(code) {
  const hex = code.toLowerCase();
  const prefix = '0x363d3d373d3d3d363d73';
  const suffix = '5af43d82803e903d91602b57fd5bf3';
  if (hex.startsWith(prefix) && hex.endsWith(suffix) && hex.length === 92) return getAddress(`0x${hex.slice(prefix.length, prefix.length + 40)}`);
  return null;
}

function classifyAbi(abi) {
  const names = new Set((abi || []).filter((x) => x && x.type === 'function').map((x) => x.name));
  const methods = [...DIRECT_SIGNATURES.keys()].filter((signature) => {
    const name = signature.slice(0, signature.indexOf('('));
    const inputs = signature.slice(signature.indexOf('(') + 1, -1).split(',').filter(Boolean);
    return (abi || []).some((x) => x.type === 'function' && x.name === name && (x.inputs || []).map((i) => i.type).join(',') === inputs.join(','));
  });
  if (names.has('mintPublic') || names.has('mintSeaDrop') || names.has('updatePublicDrop')) return { protocol: 'seadrop', methods };
  if (names.has('claim') && names.has('getClaimConditionById')) return { protocol: 'thirdweb-drop', methods };
  if (names.has('mintWithRewards') || names.has('purchase') || names.has('mintWithComment')) return { protocol: 'zora-or-custom', methods };
  return { protocol: methods.length ? 'direct' : 'unknown', methods };
}

async function inspectSeaDrop(provider, nftContract) {
  try {
    const token = new Contract(nftContract, SEADROP_TOKEN_ABI, provider);
    const allowed = await token.getAllowedSeaDrop();
    const routers = [];
    for (const routerAddress of allowed.slice(0, 8)) {
      if (!isAddress(routerAddress)) continue;
      try {
        const router = new Contract(routerAddress, SEADROP_ABI, provider);
        const [drop, payout, recipients] = await Promise.all([
          router.getPublicDrop(nftContract),
          router.getCreatorPayoutAddress(nftContract).catch(() => null),
          router.getAllowedFeeRecipients(nftContract).catch(() => [])
        ]);
        routers.push({
          address: getAddress(routerAddress),
          publicDrop: {
            mintPrice: drop.mintPrice.toString(), startTime: Number(drop.startTime), endTime: Number(drop.endTime),
            maxTotalMintableByWallet: Number(drop.maxTotalMintableByWallet), feeBps: Number(drop.feeBps), restrictFeeRecipients: Boolean(drop.restrictFeeRecipients)
          },
          creatorPayout: payout, allowedFeeRecipients: recipients.map((x) => getAddress(x)),
          now: Math.floor(Date.now() / 1000)
        });
      } catch { /* router does not expose the expected SeaDrop views */ }
    }
    return routers.length ? routers : null;
  } catch { return null; }
}

/**
 * Read-only contract inspection for the scheduling wizard. Every independent read runs in parallel;
 * nothing here can fail the wizard (unknowns come back null). `abiSources` (src/core/abiSources.js)
 * supplies verified ABIs on every registry chain.
 */
async function discoverContract(provider, address, { chain = null, abiSources = null } = {}) {
  if (!isAddress(address)) throw new Error('Invalid contract address.');
  const contract = getAddress(address);
  const [code, implSlot] = await Promise.all([provider.getCode(contract), provider.getStorage(contract, EIP1967_IMPLEMENTATION).catch(() => null)]);
  if (code === '0x') return { address: contract, hasCode: false, status: 'not-a-contract' };

  const implementation = minimalProxyImplementation(code) || slotAddress(implSlot);
  const standardAddress = implementation || contract;
  const c = new Contract(contract, READ_ABI, provider);
  const safe = (p) => p.catch(() => null);
  const call = (to, data) => provider.call({ to, data });
  const [name, symbol, totalSupply, maxSupply, erc165, erc721, erc1155, abiResult, seaDrop] = await Promise.all([
    safe(c.name()), safe(c.symbol()), safe(c.totalSupply()), safe(c.maxSupply()),
    safe(c.supportsInterface(ERC165)), safe(c.supportsInterface(ERC721)), safe(c.supportsInterface(ERC1155)),
    abiSources && chain ? abiSources.verifiedAbi(chain, standardAddress) : Promise.resolve(null),
    inspectSeaDrop(provider, contract)
  ]);
  const supports = { erc165: Boolean(erc165), erc721: Boolean(erc721), erc1155: Boolean(erc1155) };
  const classification = classifyAbi(abiResult?.abi || []);
  if (seaDrop) classification.protocol = 'seadrop';

  // thirdweb Drop: ERC-721 phases are readable now; ERC-1155 phases need the token ID the user picks.
  let thirdwebDrop = null;
  if (!seaDrop) {
    if (supports.erc1155) {
      const probe = await thirdweb.readPhases(call, contract, { standard: 'erc1155', tokenId: 0n }).catch(() => null);
      if (probe || classification.protocol === 'thirdweb-drop') thirdwebDrop = { standard: 'erc1155', needsTokenId: true, variant: probe?.variant || null };
    } else {
      const read = await thirdweb.readPhases(call, contract, { standard: 'erc721' }).catch(() => null);
      if (read && read.phases.length) thirdwebDrop = { ...read, needsTokenId: false };
    }
    if (thirdwebDrop) classification.protocol = 'thirdweb-drop';
  }
  return {
    address: contract, hasCode: true, implementation,
    name, symbol,
    totalSupply: totalSupply == null ? null : totalSupply.toString(),
    maxSupply: maxSupply == null ? null : maxSupply.toString(),
    standards: supports, nft: supports.erc721 || supports.erc1155,
    verifiedAbi: Boolean(abiResult), abi: abiResult?.abi || null, abiSource: abiResult?.source || null,
    protocol: classification.protocol, mintMethods: classification.methods, seaDrop, thirdwebDrop,
    status: 'ok'
  };
}

module.exports = { discoverContract, inspectSeaDrop, classifyAbi, minimalProxyImplementation, EIP1967_IMPLEMENTATION };
