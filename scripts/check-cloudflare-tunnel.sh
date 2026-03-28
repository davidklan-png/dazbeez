#!/bin/bash

# Default hostname
HOSTNAME="${1:-dazbeez.com}"

# Perform HTTPS request to the hostname
echo "Checking tunnel connectivity for $HOSTNAME..."
RESPONSE=$(curl -s -w "%{http_code}" -o /tmp/response.html https://$HOSTNAME)

# Check if we got a 1033 error
if [[ $RESPONSE == "1033" ]]; then
    echo "ERROR: Cloudflare Tunnel returned HTTP 1033"
    echo "This indicates the tunnel is not properly connected or the origin is unreachable."
    
    # Check DNS records for cfargotunnel.com target
    echo "Checking DNS records for $HOSTNAME..."
    DNS_RESULT=$(dig +short $HOSTNAME | grep -i cfargotunnel)
    
    if [[ -n "$DNS_RESULT" ]]; then
        echo "DNS records show cfargotunnel.com target - tunnel configuration appears correct"
    else
        echo "WARNING: No cfargotunnel.com DNS records found"
        echo "This may indicate tunnel misconfiguration or DNS propagation delay"
    fi
    
    echo "ACTION REQUIRED: Check tunnel status and origin server connectivity"
    exit 1
elif [[ $RESPONSE == "200" ]]; then
    echo "SUCCESS: Tunnel is functioning correctly"
    echo "Origin server is reachable and tunnel is properly connected"
    exit 0
else
    echo "INFO: HTTP response code $RESPONSE"
    echo "Checking if this is a Cloudflare error page..."
    
    # Check if response contains Cloudflare error content
    if grep -q "1033" /tmp/response.html 2>/dev/null; then
        echo "ERROR: Cloudflare Tunnel returned HTTP 1033"
        echo "This indicates the tunnel is not properly connected or the origin is unreachable."
        exit 1
    else
        echo "INFO: Non-1033 error encountered - may be origin server issue"
        echo "Tunnel may be connected but origin server not responding properly"
        exit 2
    fi
fi

# Cleanup
rm -f /tmp/response.html
