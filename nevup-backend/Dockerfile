FROM node:22-alpine3.21

WORKDIR /app

RUN apk upgrade --no-cache

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:api"]
