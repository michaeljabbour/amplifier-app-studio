package com.amplifier.studio

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private external fun initializeCredentialStore(context: android.content.Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    // The keyring crate needs an application context before the WebView can
    // issue its first secure-storage command. Keep this ahead of Tauri startup.
    System.loadLibrary("amplifier_studio_lib")
    initializeCredentialStore(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
