FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
ENV NODE_ENV=production
CMD ["npm", "run", "start:prod"]
