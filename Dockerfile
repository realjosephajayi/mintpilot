FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src

# Build the only browser bundle (the /import wallet portal) from source.
RUN npm ci
RUN npm run build:wallet-import
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Signing mode is NOT baked into the image: set AUTOMATION_* as deployment variables so a
# plain `docker run` can never start live mainnet signing by accident. Defaults are off/dry-run.
# UV_THREADPOOL_SIZE: wallet-key derivation (scrypt) runs on the libuv pool; 8 threads keep many
# simultaneous launch arms from queueing behind each other.
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/bot.sqlite \
    ELIGIBILITY_FILE=/app/data/eligible-addresses.json \
    UV_THREADPOOL_SIZE=8

# Railway mounts volumes as root. The entrypoint fixes the mounted data
# directory's ownership, then drops privileges before starting the bot.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY docker/railway-entrypoint.sh /usr/local/bin/mintpilot-entrypoint
RUN chmod 0755 /usr/local/bin/mintpilot-entrypoint

EXPOSE 3000
# Liveness only (/healthz). Point your platform's readiness/health check at /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM triggers the graceful drain (SHUTDOWN_DRAIN_SECONDS); give the platform at least that long.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/mintpilot-entrypoint"]
CMD ["node", "src/index.js"]
