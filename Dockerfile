FROM node:14.18.0

## TEMPORAL WORKER DOCKERFILE

COPY . .
RUN yarn install --frozen-lockfile
RUN yarn build

CMD ["yarn", "run", "temporal-worker"]
