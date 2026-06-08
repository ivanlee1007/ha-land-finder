ARG BUILD_FROM=ghcr.io/hassio-addons/base:18.0.6
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    git \
    nodejs \
    npm \
    mariadb-client \
    sed

COPY run.sh /run.sh
RUN chmod a+x /run.sh

WORKDIR /data
CMD ["/run.sh"]
