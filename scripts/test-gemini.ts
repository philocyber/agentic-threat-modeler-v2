#!/usr/bin/env tsx
/**
 * Gemini API Key Tester - All-in-one utility
 * 
 * Tests your Gemini API key and shows available models with recommendations.
 * 
 * Usage:
 *   GOOGLE_API_KEY=your-key pnpm tsx scripts/test-gemini.ts
 *   or just: pnpm tsx scripts/test-gemini.ts (reads from .env.local)
 */

import { config } from 'dotenv'

// Load .env.local
config({ path: '.env.local' })

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY

type GeminiModel = {
  name: string
  displayName?: string
  supportedGenerationMethods?: string[]
}

type GeminiResponse = {
  models?: GeminiModel[]
  error?: { message?: string }
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
}

if (!GEMINI_API_KEY) {
  console.error('❌ Error: GOOGLE_API_KEY not found')
  console.log('\nSet it in .env.local or run:')
  console.log('  GOOGLE_API_KEY=your-key pnpm tsx scripts/test-gemini.ts')
  console.log('\n🔑 Get a key at: https://aistudio.google.com/app/apikey')
  process.exit(1)
}

console.log('🔍 Testing Gemini API Key')
console.log('Key:', GEMINI_API_KEY.substring(0, 20) + '...\n')

async function testAndList() {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models'
  
  console.log('Fetching available models...\n')
  
  try {
    const response = await fetch(url, {
      headers: { 'x-goog-api-key': GEMINI_API_KEY as string },
    })
    const data = await response.json() as GeminiResponse
    
    if (!response.ok) {
      console.log('❌ API Key Error')
      console.log('Status:', response.status, response.statusText)
      console.log('Message:', data.error?.message || 'Unknown error')
      
      if (data.error?.message?.includes('API key not valid')) {
        console.log('\n⚠️  Your API key is INVALID or EXPIRED')
        console.log('🔑 Get a new one: https://aistudio.google.com/app/apikey')
      }
      process.exit(1)
    }
    
    console.log('✅ API Key is VALID!\n')
    
    // Filter generative models
    const generativeModels = (data.models || []).filter((m) => 
      m.supportedGenerationMethods?.includes('generateContent')
    )
    
    if (generativeModels.length === 0) {
      console.log('⚠️  No generative models available')
      process.exit(1)
    }
    
    // Categorize models
    const stableModels = generativeModels.filter((m) => 
      !m.name.includes('preview') && 
      !m.name.includes('exp') &&
      (m.name.includes('gemini-2.') || m.name.includes('gemini-3.'))
    )
    
    const previewModels = generativeModels.filter((m) => 
      m.name.includes('preview') && 
      (m.name.includes('gemini-3.1') || m.name.includes('gemini-3-'))
    )
    
    console.log('=' .repeat(70))
    console.log('📋 AVAILABLE MODELS')
    console.log('='.repeat(70))
    
    console.log('\n🟢 Stable Models (recommended for production):\n')
    stableModels.slice(0, 10).forEach((model) => {
      const name = model.name.replace('models/', '')
      console.log(`  ✓ ${name}`)
      if (model.displayName) console.log(`    ${model.displayName}`)
    })
    
    console.log('\n🟡 Preview Models (experimental, may change):\n')
    previewModels.slice(0, 5).forEach((model) => {
      const name = model.name.replace('models/', '')
      console.log(`  ⚠  ${name}`)
      if (model.displayName) console.log(`    ${model.displayName}`)
    })
    
    console.log(`\n📊 Total: ${generativeModels.length} models available`)
    
    // Test actual generation
    console.log('\n' + '='.repeat(70))
    console.log('🧪 TESTING GENERATION')
    console.log('='.repeat(70))
    
    const testModel = 'gemini-2.5-flash'
    console.log(`\nTesting ${testModel}...`)
    
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent`
    const testResponse = await fetch(testUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY as string,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say "OK"' }] }]
      })
    })
    
    const testData = await testResponse.json() as GeminiResponse
    
    if (testResponse.ok && testData.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.log('✅ Generation working!')
      console.log('Response:', testData.candidates[0].content.parts[0].text)
    } else {
      console.log('❌ Generation failed:', testData.error?.message)
    }
    
    // Recommendations
    console.log('\n' + '='.repeat(70))
    console.log('💡 RECOMMENDED CONFIGURATION')
    console.log('='.repeat(70))
    
    const modelNames = generativeModels.map((m) => m.name.replace('models/', ''))
    
    // Prefer stable over preview
    const has25pro = modelNames.includes('gemini-2.5-pro')
    const has25flash = modelNames.includes('gemini-2.5-flash')
    const has31pro = modelNames.includes('gemini-3.1-pro-preview')
    
    let quickModel = 'gemini-2.5-flash'
    let deepModel = 'gemini-2.5-pro'
    let notes = ''
    
    if (!has25flash) {
      quickModel =
        modelNames.find((n: string) => n.includes('flash') && !n.includes('preview')) ??
        modelNames[0] ??
        quickModel
    }
    
    if (!has25pro && has31pro) {
      deepModel = 'gemini-2.5-pro'  // Still prefer 2.5 pro over 3.1 preview
      notes = '\n⚠️  Note: gemini-3.1-pro-preview is available but is experimental.\n    Stick with gemini-2.5-pro for stability.'
    }
    
    console.log('\nAdd to your .env.local:\n')
    console.log('LLM_PROVIDER="google"')
    console.log(`GOOGLE_API_KEY="${GEMINI_API_KEY}"`)
    console.log(`GEMINI_QUICK_MODEL="${quickModel}"`)
    console.log(`GEMINI_DEEP_MODEL="${deepModel}"`)
    
    if (notes) console.log(notes)
    
    console.log('\n' + '='.repeat(70))
    console.log('📚 MODEL COMPARISON')
    console.log('='.repeat(70))
    
    console.log('\ngemini-2.5-pro (RECOMMENDED for deep reasoning):')
    console.log('  • Status: Stable (June 2025 release)')
    console.log('  • Best for: Complex threat analysis, debate, synthesis')
    console.log('  • Quality: Production-ready')
    console.log('  • Cost: ~$1.25 input / $5 output per 1M tokens')
    
    if (has31pro) {
      console.log('\ngemini-3.1-pro-preview (experimental):')
      console.log('  • Status: Preview (may change without notice)')
      console.log('  • Best for: Testing latest features')
      console.log('  • Quality: Not guaranteed stable')
      console.log('  • Recommendation: Use 2.5-pro for production')
    }
    
    console.log('\n✅ Done! Your Gemini API is ready to use.\n')
    
  } catch (error: unknown) {
    console.log('❌ Network Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

testAndList()
