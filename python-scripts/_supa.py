# python-scripts/_supa.py
import os
from supabase import create_client

DEFAULT_SUPABASE_URL = "https://qsarkbzmqjsnyrcackwm.supabase.co"
DEFAULT_SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzYXJrYnptcWpzbnlyY2Fja3dtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTgzODY3NiwiZXhwIjoyMDc3NDE0Njc2fQ.HAyvVKMLGdJigQ-SrPbtclv_MxxLKoqj54UyUaAjvtM"

def supa():
    """
    Consistent Supabase client across all scripts.
    Priority:
      1) .env.local or shell env (SUPABASE_URL / SUPABASE_SERVICE_ROLE)
      2) fallback defaults (so scripts work even if env isn't loaded)
    """
    url = os.getenv("SUPABASE_URL") or DEFAULT_SUPABASE_URL
    key = os.getenv("SUPABASE_SERVICE_ROLE") or DEFAULT_SERVICE_ROLE

    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE.")
    return create_client(url, key)
