FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
RUN pnpm build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/sql ./sql
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
