FROM node:14-alpine
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn --prod && rm -rf .npmrc

FROM node:14-alpine
WORKDIR /app
COPY --from=0 /app .
COPY dist .
CMD ["node", "./dist/index.js"]