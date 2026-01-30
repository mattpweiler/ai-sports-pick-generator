import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_MODEL_VERSION } from "@/lib/predictions";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

export async function GET() {
  let versions: string[] = [];
  try {
    const { data, error } = await supabase
      .from("ml_model_registry")
      .select("model_version, created_at")
      .order("created_at", { ascending: false })
      .limit(15);

    if (error) {
      console.warn("Error loading model versions:", error);
    } else if (Array.isArray(data)) {
      versions = data
        .map((row) => row.model_version)
        .filter((v): v is string => typeof v === "string");
    }
  } catch (err) {
    console.warn("Model versions lookup failed:", err);
  }

  if (!versions.length) {
    versions = [DEFAULT_MODEL_VERSION];
  }

  return NextResponse.json({
    versions,
    latest: versions[0],
  });
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
