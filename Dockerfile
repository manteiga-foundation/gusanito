FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY src ./src
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
USER bun
CMD ["bun", "src/server/main.ts"]
