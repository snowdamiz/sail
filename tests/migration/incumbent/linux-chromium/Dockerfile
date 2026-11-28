FROM node:26.13.1-bookworm-slim

RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends \
    curl git python3 unzip fontconfig fonts-dejavu-core libatomic1 node-ws \
    libnss3 libglib2.0-0 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 \
    libgbm1 libasound2 libexpat1 libdrm2 libcairo2 libpango-1.0-0 \
  && rm -rf /var/lib/apt/lists/*
