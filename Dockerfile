FROM node:14-alpine
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn --prod

FROM node:14-alpine
WORKDIR /app
COPY --from=0 /app .
COPY dist ./dist
CMD ["node", "./dist/index.js"]