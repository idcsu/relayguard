package common

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

const TOTPPeriodSeconds = 30

// totpUsedCodes tracks recently used TOTP codes per user to prevent replay.
// Key: "userID:secretHash:timeStep", Value: expiry time.
var totpUsedCodes sync.Map

func init() {
	// Periodically clean up expired TOTP used-code entries
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			now := time.Now()
			totpUsedCodes.Range(func(key, value any) bool {
				if value.(time.Time).Before(now) {
					totpUsedCodes.Delete(key)
				}
				return true
			})
		}
	}()
}

func GenerateTOTPSecret() (string, error) {
	raw, err := RandomToken(20)
	if err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte(raw)), nil
}

func TOTPURI(issuer, account, secret string) string {
	if issuer == "" {
		issuer = ProjectName
	}
	label := url.PathEscape(issuer + ":" + account)
	v := url.Values{}
	v.Set("secret", strings.ToUpper(strings.TrimSpace(secret)))
	v.Set("issuer", issuer)
	v.Set("algorithm", "SHA1")
	v.Set("digits", "6")
	v.Set("period", fmt.Sprint(TOTPPeriodSeconds))
	return "otpauth://totp/" + label + "?" + v.Encode()
}

func VerifyTOTP(secret, code string, now time.Time) bool {
	return VerifyTOTPWithReplay("", secret, code, now)
}

// VerifyTOTPWithReplay verifies a TOTP code and also prevents replay attacks.
// userID should be the user's ID (empty string skips replay check).
// Each (userID, secret, timeStep) combination can only be used once.
func VerifyTOTPWithReplay(userID, secret, code string, now time.Time) bool {
	secret = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	code = strings.TrimSpace(code)
	if len(code) != 6 || secret == "" {
		return false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	step := now.Unix() / TOTPPeriodSeconds
	for offset := int64(-1); offset <= 1; offset++ {
		if step+offset < 0 {
			continue
		}
		candidate, err := hotp(secret, uint64(step+offset))
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			// Check replay: each (user, secret, timeStep) can only be used once
			if userID != "" {
				key := fmt.Sprintf("%s:%s:%d", userID, secret, step+offset)
				if _, loaded := totpUsedCodes.LoadOrStore(key, now.Add(3*time.Minute)); loaded {
					return false // already used
				}
			}
			return true
		}
	}
	return false
}

func hotp(secret string, counter uint64) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		key, err = base32.StdEncoding.DecodeString(secret)
		if err != nil {
			return "", err
		}
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[offset])&0x7f)<<24 | (uint32(sum[offset+1])&0xff)<<16 | (uint32(sum[offset+2])&0xff)<<8 | (uint32(sum[offset+3]) & 0xff)
	return fmt.Sprintf("%06d", bin%1000000), nil
}
