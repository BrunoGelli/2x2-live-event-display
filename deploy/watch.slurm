#!/bin/bash
#SBATCH --job-name=live2x2-worker
#SBATCH --constraint=cpu
#SBATCH --qos=shared
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --time=04:00:00
#SBATCH --output=live2x2-worker-%j.log
set -euo pipefail
: "${LIVE2X2_PYTHON:?Set LIVE2X2_PYTHON to the installed Python executable}"
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
srun --cpu-bind=cores "$LIVE2X2_PYTHON" -m live2x2.cli watch "$@"
