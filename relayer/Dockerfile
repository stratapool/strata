# Build context is the repo root, not relayer/: the service depends on
# ../shared via a file: reference and on the circuit's verification key.
#
#   docker build -f relayer/Dockerfile -t strata-relayer .

FROM node:22-alpine AS build
WORKDIR /build

COPY shared/package.json ./shared/
COPY relayer/package.json ./relayer/
RUN cd shared && npm install --omit=dev --no-audit --no-fund
RUN cd relayer && npm install --no-audit --no-fund

COPY shared ./shared
COPY relayer ./relayer
RUN cd relayer && npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /build/shared /app/shared
COPY --from=build /build/relayer/node_modules /app/node_modules
COPY --from=build /build/relayer/dist /app/dist
COPY --from=build /build/relayer/package.json /app/package.json

# The verification key is baked in rather than mounted: it must match the
# circuit the deployed verifier was generated from, and a mismatched key
# would silently reject every honest proof.
COPY circuits/build/verification_key.json /app/circuits/verification_key.json
ENV VERIFICATION_KEY=/app/circuits/verification_key.json

# The hot wallet keystore is mounted at runtime, never copied into the image.
RUN addgroup -S relay && adduser -S relay -G relay
USER relay

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
