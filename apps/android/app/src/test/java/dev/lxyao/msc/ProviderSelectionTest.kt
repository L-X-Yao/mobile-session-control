package dev.lxyao.msc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProviderSelectionTest {
    private fun provider(id: String, enabled: Boolean = true) = Provider(
        id = id,
        label = "Provider $id",
        model = "native",
        effort = "low",
        transport = "anthropic-compatible-sse",
        enabled = enabled,
    )

    @Test
    fun keepsExplicitSelection() {
        assertEquals(
            "native-2",
            retainedProviderId("native-2", listOf(provider("native-1"), provider("native-2"))),
        )
    }

    @Test
    fun doesNotAutoSelectFirstProvider() {
        assertNull(retainedProviderId(null, listOf(provider("native-1"))))
    }

    @Test
    fun clearsDisabledSelection() {
        assertNull(retainedProviderId("native-1", listOf(provider("native-1", enabled = false))))
    }

    @Test
    fun clearsMissingSelection() {
        assertNull(retainedProviderId("native-9", listOf(provider("native-1"))))
    }
}
