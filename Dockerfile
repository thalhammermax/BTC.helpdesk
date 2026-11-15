# ---- build ----
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web && npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4000 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/seed.js && node dist/index.js"]
