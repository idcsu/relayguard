package common

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

const passwordIterations = 180000

func RandomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func RandomID(prefix string) string {
	s, err := RandomToken(12)
	if err != nil {
		return fmt.Sprintf("%s%x", prefix, sha256.Sum256([]byte(prefix)))[:len(prefix)+12]
	}
	if prefix == "" {
		return s
	}
	return prefix + "_" + s
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func HashPassword(password string) (string, error) {
	salt, err := RandomToken(18)
	if err != nil {
		return "", err
	}
	dk := pbkdf2SHA256([]byte(password), []byte(salt), passwordIterations, 32)
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", passwordIterations, salt, base64.RawStdEncoding.EncodeToString(dk)), nil
}

func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	var iter int
	if _, err := fmt.Sscanf(parts[1], "%d", &iter); err != nil || iter <= 0 || iter > 1000000 {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	dk := pbkdf2SHA256([]byte(password), []byte(parts[2]), iter, len(expected))
	return subtle.ConstantTimeCompare(dk, expected) == 1
}

func HMACSHA256Hex(secret string, data []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

func VerifyHMACSHA256Hex(secret string, data []byte, signature string) bool {
	expected := HMACSHA256Hex(secret, data)
	return subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) == 1
}

// NodeSecretHMAC returns an HMAC-SHA256 digest of the node secret using a
// server-level key. This is reserved for a future migration where node secrets
// will be stored as HMAC digests rather than plaintext.
func NodeSecretHMAC(serverKey, secret string) string {
	return HMACSHA256Hex(serverKey, []byte(secret))
}

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	hLen := 32
	numBlocks := (keyLen + hLen - 1) / hLen
	var out []byte
	for block := 1; block <= numBlocks; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		mac.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := mac.Sum(nil)
		t := make([]byte, hLen)
		copy(t, u)
		for i := 1; i < iter; i++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for j := 0; j < hLen; j++ {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}
