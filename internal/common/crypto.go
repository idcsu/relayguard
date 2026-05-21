package common

import (
	"crypto/aes"
	"crypto/cipher"
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

// NodeSecretHMAC is NOT used for node secrets since they must be recoverable
// for HMAC heartbeat verification. Node secrets use AES-GCM encryption instead
// (see EncryptSecret/DecryptSecret in Store).
// NodeSecretHMAC is kept for future use (e.g., webhook secret verification).
func NodeSecretHMAC(serverKey, secret string) string {
	return HMACSHA256Hex(serverKey, []byte(secret))
}

// EncryptSecret encrypts a plaintext string using AES-GCM with the given key.
// Returns a base64-encoded string prefixed with "enc:" for storage.
// This allows storing secrets securely in the database while still being
// recoverable for HMAC heartbeat verification.
func EncryptSecret(key, plaintext string) (string, error) {
	aesKey := deriveAESKey(key)
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return "enc:" + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

// DecryptSecret decrypts an AES-GCM encrypted string (prefixed with "enc:").
// If the input is not prefixed with "enc:", it is returned as-is (legacy plaintext).
func DecryptSecret(key, stored string) (string, error) {
	if !strings.HasPrefix(stored, "enc:") {
		return stored, nil // legacy plaintext
	}
	data, err := base64.RawURLEncoding.DecodeString(stored[4:])
	if err != nil {
		return "", fmt.Errorf("解密密钥失败：%w", err)
	}
	aesKey := deriveAESKey(key)
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("密钥数据长度不足")
	}
	plaintext, err := gcm.Open(nil, data[:nonceSize], data[nonceSize:], nil)
	if err != nil {
		return "", fmt.Errorf("密钥验证失败")
	}
	return string(plaintext), nil
}

// IsEncryptedSecret returns true if the stored value is an AES-GCM encrypted secret.
func IsEncryptedSecret(stored string) bool {
	return strings.HasPrefix(stored, "enc:")
}

// deriveAESKey derives a 32-byte AES-256 key from a server key string using SHA-256.
func deriveAESKey(key string) []byte {
	h := sha256.Sum256([]byte(key))
	return h[:]
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
