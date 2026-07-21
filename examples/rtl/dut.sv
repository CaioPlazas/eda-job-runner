// Stub DUT used only so mock_uvm_sim.sh has a real file/line to report
// against, for testing the EDA Job Runner sidebar without a real simulator.
module dut #(
  parameter WIDTH = 32
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic [WIDTH-1:0] data_in,
  output logic [WIDTH-1:0] data_out
);

  logic [WIDTH-1:0] data_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      data_q <= '0;
    end else begin
      data_q <= data_in;
    end
  end

  assign data_out = data_q;

  // line 20
  // line 21
  // line 22
  // line 23
  // line 24
  // line 25
  // line 26
  // line 27
  // line 28
  // line 29
  // line 30
  // line 31
  // line 32
  // line 33
  // line 34: pretend this is where mock_uvm_sim.sh's warning "comes from"
  // line 35
  // line 36
  // line 37
  // line 38
  // line 39
  // line 40
  // line 41: pretend this is where mock_uvm_sim.sh's first error "comes from"

endmodule
