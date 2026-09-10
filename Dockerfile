FROM node:20-alpine
RUN apk add --no-cache git python3 make g++ curl
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD curl -f http://localhost:3000/health || exit 1
CMD ["npm", "start"]
