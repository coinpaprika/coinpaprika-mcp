FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ dist/
COPY LICENSE README.md CHANGELOG.md ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
