FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

RUN mkdir -p /app/data

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
