FROM node:20-alpine
WORKDIR /app

# Install production deps without running lifecycle scripts (the build runs explicitly below)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy source and build dist/ inside the image (dist/ is gitignored, so it must be built here,
# not COPYd, otherwise a clean checkout build fails)
COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
