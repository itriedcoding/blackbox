#!/usr/bin/env python3
"""Merge a PEFT LoRA adapter into its base model and save plain HF weights.

The merged directory is then converted to GGUF by llama.cpp's own
convert_hf_to_gguf.py, which is what Blackbox loads.
"""
import argparse

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--model", required=True, help="base model repo id or directory")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.float32, low_cpu_mem_usage=True)
    merged = PeftModel.from_pretrained(model, args.adapter)
    merged = merged.merge_and_unload()
    merged.save_pretrained(args.out, safe_serialization=True)
    AutoTokenizer.from_pretrained(args.adapter).save_pretrained(args.out)
    print("merged", args.out, flush=True)


if __name__ == "__main__":
    main()
