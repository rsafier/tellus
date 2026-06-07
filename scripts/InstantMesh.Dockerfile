FROM nvidia/cuda:12.1.1-devel-ubuntu22.04

LABEL name="tellus-instantmesh"

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1
ENV CUDA_HOME=/usr/local/cuda
ENV PATH="/usr/local/cuda/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH}"
ENV TORCH_CUDA_ARCH_LIST="8.6"

RUN mkdir -p /workspace/instantmesh
WORKDIR /workspace

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      ffmpeg \
      git \
      libegl1-mesa-dev \
      libglib2.0-0 \
      ninja-build \
      python3.10 \
      python3.10-dev \
      python3.10-distutils \
      python3.10-venv \
      tzdata \
      unzip \
      wget && \
    ln -sf /usr/bin/python3.10 /usr/local/bin/python && \
    curl -sS https://bootstrap.pypa.io/get-pip.py | python && \
    rm -rf /var/lib/apt/lists/*

RUN python -m pip install -U pip "setuptools<70" wheel && \
    python -m pip install \
      torch==2.1.0 torchvision==0.16.0 torchaudio==2.1.0 \
      --index-url https://download.pytorch.org/whl/cu121 && \
    python -m pip install xformers==0.0.22.post7 triton "numpy<2" "setuptools<70"

RUN python -c "import torch; from torch.utils.cpp_extension import CUDA_HOME, CUDAExtension; print('torch', torch.__version__, 'cuda_home', CUDA_HOME); assert CUDA_HOME"

WORKDIR /workspace/instantmesh

ADD requirements.txt /workspace/instantmesh/requirements.txt
RUN printf '%s\n' \
      'torch==2.1.0+cu121' \
      'torchvision==0.16.0+cu121' \
      'torchaudio==2.1.0+cu121' \
      'triton==2.1.0' \
      'numpy<2' \
      'setuptools<70' \
      'accelerate==0.23.0' \
      'fastapi==0.103.2' \
      'starlette==0.27.0' \
      'pydantic==1.10.15' \
      > /tmp/instantmesh-constraints.txt && \
    grep -v '^bitsandbytes$' requirements.txt > /tmp/instantmesh-requirements.txt && \
    python -m pip install --no-build-isolation \
      --extra-index-url https://download.pytorch.org/whl/cu121 \
      -c /tmp/instantmesh-constraints.txt \
      -r /tmp/instantmesh-requirements.txt && \
    python -m pip install onnxruntime && \
    python -c "import torch, numpy; print('post-requirements torch', torch.__version__, 'numpy', numpy.__version__); assert torch.__version__.startswith('2.1.0')"

COPY . /workspace/instantmesh

EXPOSE 43839
CMD ["python", "app.py"]
