#!/usr/bin/env bash
set -euo pipefail

out="${1:-certs}"
mkdir -p "$out"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 \
  -keyout "$out/key.pem" \
  -out "$out/cert.pem" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

chmod 600 "$out/key.pem"
printf 'Wrote %s/cert.pem and %s/key.pem\n' "$out" "$out"
printf 'Start the API with: npm run api -- --tls-cert %s/cert.pem --tls-key %s/key.pem\n' "$out" "$out"
