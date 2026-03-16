# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node scripts/patch-passkit-generator.js
RUN npm run build

# Stage 2: Run
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY scripts/patch-passkit-generator.js ./scripts/
RUN npm ci --omit=dev && node scripts/patch-passkit-generator.js
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
