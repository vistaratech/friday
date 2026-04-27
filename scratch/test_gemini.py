import os
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

api_key = os.getenv("GOOGLE_API_KEY")
print(f"Testing key: {api_key[:10]}...{api_key[-5:]}")

client = genai.Client(api_key=api_key)

print("Listing available models...")
try:
    for m in client.models.list():
        print(f" - {m.name}")
    
    print("\nAttempting generation with 'gemini-2.5-flash'...")
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents='Say "System Check OK"'
    )
    print("\n✅ SUCCESS! Google accepted the key and generated content.")
    print(f"Response: {response.text}")
except Exception as e:
    print("\n❌ FAILED!")
    print(f"Error Type: {type(e).__name__}")
    print(f"Error Message: {str(e)}")
