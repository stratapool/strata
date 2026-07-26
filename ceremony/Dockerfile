# Build context is the repo root, not ceremony/.
#
#   docker build -f ceremony/Dockerfile -t strata-ceremony .

FROM node:22-alpine AS build
WORKDIR /build

COPY ceremony/package.json ./ceremony/
RUN cd ceremony && npm install --no-audit --no-fund

COPY ceremony ./ceremony
RUN cd ceremony && npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /build/ceremony/node_modules /app/node_modules
COPY --from=build /build/ceremony/dist /app/dist
COPY --from=build /build/ceremony/package.json /app/package.json

# The circuit and the powers of tau are mounted rather than copied: together
# they are ~82 MB of static input that never changes with the service, and a
# verification reads them from disk in chunks.
ENV R1CS_PATH=/circuits/withdraw.r1cs
ENV PTAU_PATH=/circuits/pot16_final.ptau
ENV DATA_DIR=/data

RUN addgroup -S ceremony && adduser -S ceremony -G ceremony
USER ceremony

EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8789)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
