#!/bin/sh
# Run from the server that can reach your devices. Usage:
#   ./scripts/snmp-walk.sh <host> <community> [oid] [port]
# Example:
#   ./scripts/snmp-walk.sh 192.168.88.1 c4ct1
#   ./scripts/snmp-walk.sh 172.16.10.1 c4ct1 1.3.6.1.2.1.2.2.1
#   ./scripts/snmp-walk.sh 192.168.88.1 c4ct1 1.3.6.1.2.1.31.1.1.1 161
set -e
HOST="${1:?usage: $0 host community [oid] [port]}"
COMMUNITY="${2:?usage: $0 host community [oid] [port]}"
OID="${3:-1.3.6.1.2.1.2.2.1}"
PORT="${4:-161}"
echo "=== snmpwalk -v2c -c $COMMUNITY ${HOST}:${PORT} $OID ==="
snmpwalk -v2c -c "$COMMUNITY" -t 3 -r 1 "${HOST}:${PORT}" "$OID"
