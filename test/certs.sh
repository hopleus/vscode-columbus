# Test certificate authority and certificates, sourced by the scripts that start TLS servers.

# ca <directory>
ca() {
	openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1/ca.key" -out "$1/ca.crt" -days 30 -subj "/CN=Columbus Test CA" 2>/dev/null
}

# cert <directory> <name> <subjectAltName>
cert() {
	openssl req -newkey rsa:2048 -nodes -keyout "$1/$2.key" -out "$1/$2.csr" -subj "/CN=$2" 2>/dev/null
	printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth,clientAuth\n' "$3" > "$1/$2.ext"
	openssl x509 -req -in "$1/$2.csr" -CA "$1/ca.crt" -CAkey "$1/ca.key" -CAcreateserial -out "$1/$2.crt" -days 30 -extfile "$1/$2.ext" 2>/dev/null
	chmod 644 "$1/$2.key"
}
