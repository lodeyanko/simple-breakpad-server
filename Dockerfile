ARG FROM_REPO=node
ARG FROM_VERSION=24.13.0-alpine3.23

FROM alpine:3.23 AS builder

RUN apk --no-cache upgrade --all \
    && apk --no-cache add rust cargo clang \
    && cargo install minidump-stackwalk

FROM ${FROM_REPO}:${FROM_VERSION}

RUN apk --no-cache upgrade --all

RUN mkdir -p /breakpad-server/{bin,src,views} \
    && apk --no-cache add bash \
    && npm install -g npm@latest

ENV PATH=${PATH}:/breakpad-server/bin

COPY --from=builder /root/.cargo/bin/minidump-stackwalk /breakpad-server/bin/

COPY package.json tsconfig.json .yarnrc.yml LICENSE README.md /breakpad-server/
COPY src /breakpad-server/src/
COPY views /breakpad-server/views/
COPY bin /breakpad-server/bin/

RUN cd /breakpad-server \
    && corepack enable \
    && yarn install \
    && yarn clean \
    && yarn build \
    && yarn cache clean \
    && corepack disable \
    && corepack cache clear

WORKDIR /breakpad-server
ENV HOME=/breakpad-server

EXPOSE 1127

ENV NODE_OPTIONS="--max_old_space_size=3072"

CMD ["simple-breakpad-server"]