FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY proto ./proto
COPY scripts/healthcheck.cjs ./scripts/healthcheck.cjs
COPY scripts/seed-stock.cjs ./scripts/seed-stock.cjs
USER node
EXPOSE 50051
CMD ["node", "dist/main.js"]
