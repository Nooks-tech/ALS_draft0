FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
# Copy package manifests + the postinstall script *before* `npm ci`, since
# the postinstall hook (patch-passkit-generator.js) needs to exist on disk
# the moment `npm ci` runs. Doing `COPY . .` after npm ci would place the
# script too late and the install would fail.
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "index.ts"]
