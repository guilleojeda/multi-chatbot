# Official Node.js image manifest list digest verified to include linux/arm64.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

WORKDIR /app
COPY --chown=node:node entry.mjs ./entry.mjs
USER node
EXPOSE 8080
CMD ["node", "entry.mjs"]
