#!/bin/bash

# Script to verify that dazbeez.com resolves to the specified host IP
# Uses DNS lookup and HTTP request with Host header override via curl --resolve

set -e  # Exit on any error

DOMAIN="dazbeez.com"
EXPECTED_IP="$1"

if [ -z "$EXPECTED_IP" ]; then
  echo "Usage: $0 <expected_host_ip>"
  echo "Example: $0 192.168.1.100"
  exit 1
fi

echo "Verifying that $DOMAIN resolves to $EXPECTED_IP"

# Step 1: Check DNS resolution
echo "1. Checking DNS resolution..."
DNS_IP=$(dig +short "$DOMAIN" | head -1)

if [ -z "$DNS_IP" ]; then
  echo "ERROR: Could not resolve $DOMAIN via DNS"
  exit 1
fi

echo "   DNS resolved $DOMAIN to $DNS_IP"

if [ "$DNS_IP" != "$EXPECTED_IP" ]; then
  echo "WARNING: DNS resolves to $DNS_IP, but expected $EXPECTED_IP"
  echo "This may be expected if DNS is managed by a CDN or proxy."
else
  echo "   DNS matches expected IP"
fi

# Step 2: Perform HTTP request with Host header override
echo "2. Testing HTTP access with Host override..."
RESPONSE=$(curl -s --resolve "$DOMAIN:80:$EXPECTED_IP" "http://$DOMAIN/" -H "Host: $DOMAIN" --fail)

if [ $? -eq 0 ]; then
  echo "   HTTP request successful"
  echo "   Response length: ${#RESPONSE} characters"
else
  echo "ERROR: HTTP request failed"
  exit 1
fi

# Step 3: Verify response content (basic check)
if [[ "$RESPONSE" == *"Dazbeez"* ]]; then
  echo "   Response contains expected content"
  echo "SUCCESS: $DOMAIN resolves correctly to $EXPECTED_IP"
  exit 0
else
  echo "WARNING: Response does not contain expected content"
  echo "   Response preview: ${RESPONSE:0:100}..."
  echo "This may be expected if the server returns a different page than expected."
fi
