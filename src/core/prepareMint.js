'use strict';
// The single preparation path used by the executor, /ready and /preflight:
//   resolve live eligibility data -> build calldata -> check the SeaDrop router -> simulate.
// The executor runs the router check in parallel with its other reads (checkRouter: false here,
// then routerCheck itself); /ready and /preflight use the sequential form.
const { resolveMintSpec } = require('./eligibilityProviders');
const { buildMintTx } = require('./mintTx');
const { isSeaDropRoute } = require('./mintAdapters');
const { assertSeaDropRouterAuthorized } = require('./seaDropAuthorization');

function storedSpec(schedule) {
  if (schedule.mintSpec) return schedule.mintSpec;
  if (!schedule.mint_spec) return null;
  try { return JSON.parse(schedule.mint_spec); } catch { return schedule.mint_spec; } // resolveMintSpec reports bad JSON
}

/** Resolves when the NFT contract lists the transaction's SeaDrop router (no-op for other routes). */
async function routerCheck(rpc, schedule, spec, tx, options = {}) {
  if (spec && isSeaDropRoute(spec.adapter)) await assertSeaDropRouterAuthorized(rpc, schedule, tx, options);
}

async function resolveAndBuild(schedule, { rpc, cfg, now, fetchImpl, buildMintTx: build = buildMintTx, checkRouter = true } = {}) {
  const raw = storedSpec(schedule);
  const spec = raw ? await resolveMintSpec(raw, schedule, { now, cfg, fetchImpl }) : null;
  const tx = spec ? build({ ...schedule, mint_spec: JSON.stringify(spec), mintSpec: spec }) : build(schedule);
  if (checkRouter) await routerCheck(rpc, schedule, spec, tx, { trustedRouters: cfg?.openSeaTrustedRouters });
  return { spec, tx };
}

async function prepareMint(schedule, ctx = {}) {
  const { spec, tx } = await resolveAndBuild(schedule, ctx);
  const simulation = ctx.simulate === false ? null : await ctx.rpc.simulate(schedule.chain, tx);
  return { spec, tx, simulation };
}

module.exports = { prepareMint, resolveAndBuild, routerCheck, storedSpec };
