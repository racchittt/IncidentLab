FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY services/runtime ./services/runtime
COPY services/payment-service ./services/payment-service
RUN npm install
WORKDIR /app/services/payment-service
CMD ["npx", "tsx", "index.ts"]
