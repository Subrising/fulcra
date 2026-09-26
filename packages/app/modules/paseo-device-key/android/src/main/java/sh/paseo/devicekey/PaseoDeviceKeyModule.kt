package sh.paseo.devicekey

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

// The Android device key. A P-256 key generated inside the Android Keystore
// (StrongBox when the phone has one), non-exportable, that requires a strong biometric for every
// signature: the Keystore refuses to sign until BiometricPrompt authenticates this exact operation.
// JavaScript receives only the public key (SPKI) and DER signatures.

// Each pairing has its own immutable Keystore alias, named after its device id, so a signature is
// always reported with the id of the exact key that made it. Pair and sign run one at a time.
private const val KEY_ALIAS_PREFIX = "ai.fulcra.device-key."
private const val PREFS = "ai.fulcra.device-key"

private fun aliasFor(deviceId: String) = KEY_ALIAS_PREFIX + deviceId

class PaseoDeviceKeyModule : Module() {
  private val busy = java.util.concurrent.atomic.AtomicBoolean(false)

  // One operation at a time; a second one is refused rather than interleaved with the first.
  private fun begin(promise: Promise): Boolean {
    if (busy.compareAndSet(false, true)) return true
    promise.reject("E_BUSY", "Another device-key operation is in progress", null)
    return false
  }

  private fun end() = busy.set(false)

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is unavailable" }

  private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun biometricsAvailable(): Boolean =
    BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun activity(): FragmentActivity? = appContext.currentActivity as? FragmentActivity

  private fun cancelCode(errorCode: Int): String =
    when (errorCode) {
      BiometricPrompt.ERROR_USER_CANCELED,
      BiometricPrompt.ERROR_NEGATIVE_BUTTON,
      BiometricPrompt.ERROR_CANCELED -> "E_CANCELLED"
      else -> "E_FAILED"
    }

  // Runs the prompt; the busy flag is released on every outcome.
  private fun prompt(
    reason: String,
    crypto: BiometricPrompt.CryptoObject?,
    promise: Promise,
    onSuccess: (BiometricPrompt.AuthenticationResult) -> Unit,
  ) {
    val activity = activity()
    if (activity == null) {
      end()
      promise.reject("E_FAILED", "The app is not in the foreground", null)
      return
    }
    activity.runOnUiThread {
      val callback =
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            try {
              onSuccess(result)
            } finally {
              end()
            }
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            end()
            promise.reject(cancelCode(errorCode), "Nothing was signed", null)
          }
        }
      val info =
        BiometricPrompt.PromptInfo.Builder()
          .setTitle("Fulcra")
          .setSubtitle(reason)
          .setAllowedAuthenticators(BIOMETRIC_STRONG)
          .setNegativeButtonText("Cancel")
          .build()
      val biometricPrompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
      if (crypto == null) biometricPrompt.authenticate(info) else biometricPrompt.authenticate(info, crypto)
    }
  }

  private fun generateKey(alias: String, strongBox: Boolean): java.security.KeyPair {
    val builder =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(true)
        .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    }
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    generator.initialize(builder.build())
    return generator.generateKeyPair()
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoDeviceKey")

    AsyncFunction("status") {
      val deviceId = prefs().getString("deviceId", null)
      val publicKey = prefs().getString("publicKey", null)
      if (deviceId != null && publicKey != null && keyStore().containsAlias(aliasFor(deviceId))) {
        mapOf(
          "paired" to true,
          "deviceId" to deviceId,
          "publicKey" to publicKey,
          "keyStorage" to "android-keystore",
          "userPresence" to true,
        )
      } else {
        mapOf("paired" to false, "keyStorage" to "android-keystore", "userPresence" to biometricsAvailable())
      }
    }

    // Asks for a strong biometric first; only then generates the key.
    AsyncFunction("pair") { reason: String, promise: Promise ->
      if (!biometricsAvailable()) {
        promise.reject("E_NO_BIOMETRICS", "Set up a fingerprint or face unlock to pair this device", null)
        return@AsyncFunction
      }
      if (!begin(promise)) return@AsyncFunction
      prompt(reason, null, promise) {
        try {
          val previousId = prefs().getString("deviceId", null)
          val deviceId = UUID.randomUUID().toString()
          val alias = aliasFor(deviceId)
          val pair =
            try {
              generateKey(alias, strongBox = true)
            } catch (error: StrongBoxUnavailableException) {
              generateKey(alias, strongBox = false)
            }
          val publicKey = Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
          // The new key exists before the record points at it; the old key goes last.
          prefs().edit().putString("deviceId", deviceId).putString("publicKey", publicKey).commit()
          if (previousId != null && previousId != deviceId) keyStore().deleteEntry(aliasFor(previousId))
          promise.resolve(
            mapOf(
              "deviceId" to deviceId,
              "publicKey" to publicKey,
              "keyStorage" to "android-keystore",
              "userPresence" to true,
            ),
          )
        } catch (error: Exception) {
          promise.reject("E_FAILED", "The device key could not be created", error)
        }
      }
    }

    // Signs the given bytes (base64) inside the Keystore after a strong biometric bound to this
    // signature; returns the DER ECDSA signature and the device id of the key that made it.
    AsyncFunction("sign") { dataBase64: String, reason: String, promise: Promise ->
      val data = Base64.decode(dataBase64, Base64.DEFAULT)
      if (!begin(promise)) return@AsyncFunction
      // The device id and the key it names are selected together; the signature is reported with
      // exactly that id.
      val deviceId = prefs().getString("deviceId", null)
      val key = deviceId?.let { keyStore().getKey(aliasFor(it), null) as? PrivateKey }
      if (deviceId == null || key == null) {
        end()
        promise.reject("E_NOT_PAIRED", "This device is not paired", null)
        return@AsyncFunction
      }
      val signature =
        try {
          Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
        } catch (error: Exception) {
          end()
          promise.reject("E_FAILED", "Nothing was signed", error)
          return@AsyncFunction
        }
      prompt(reason, BiometricPrompt.CryptoObject(signature), promise) { result ->
        try {
          val authorized = requireNotNull(result.cryptoObject?.signature)
          authorized.update(data)
          promise.resolve(
            mapOf(
              "signature" to Base64.encodeToString(authorized.sign(), Base64.NO_WRAP),
              "deviceId" to deviceId,
            ),
          )
        } catch (error: Exception) {
          promise.reject("E_FAILED", "Nothing was signed", error)
        }
      }
    }
  }
}
