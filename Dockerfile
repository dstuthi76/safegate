# Cloud Run image for the safegate web service.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
RUN npm install --no-audit --no-fund --loglevel=error
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error
COPY --from=build /app/dist ./dist
COPY web ./web
COPY examples/demo-app ./examples/demo-app
# Scanned repositories are unpacked under /tmp and never executed.
USER node
EXPOSE 8080
CMD ["node", "dist/src/cli.js", "serve"]
