package dev.lxyao.msc

// Keep an explicit provider choice only while it is still present and enabled.
// A null result means the user must pick one; never fall back to the first
// entry, because a native relay's first entry can be a live user session.
internal fun retainedProviderId(current: String?, providers: List<Provider>): String? =
    current?.takeIf { id -> providers.any { provider -> provider.id == id && provider.enabled } }
